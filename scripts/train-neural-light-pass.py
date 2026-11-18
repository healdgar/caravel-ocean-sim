#!/usr/bin/env python3
"""
Offline trainer for Waterworld's WebGPU 1-Step Conditional Flow & Detail Pass.

Trains two coupled neural modules against 96-ray metric 3D screen-space path-traced
global illumination, horizon-bounded contact occlusion, and 3D depth-masked optical
micro-detail targets captured from live Waterworld scenes:

1. Quarter-resolution Multi-Scale ConvNeXt Conditional Flow Network (12 -> 16 -> 12 -> 16 -> 12 -> 4):
   - Stem 1x1 projection + SiLU (with IEEE FP16 round-trip matching pack2x16float)
   - Block 1: 3x3 local + dilation-5 cardinal spatial conv + 12->16->12 SiLU MLP + skip
   - Block 2: 3x3 local + dilation-14 cardinal spatial conv + 12->16->12 SiLU MLP + skip
   - Output head: 12 -> 4 predicting (occLogGain, bounceR, bounceG, bounceB)
   Trained separately for both 'fast' (zero depthStoreOp, pure HDR + Frame ray cues)
   and 'depth' (3D metric depth + reconstructed surface normals) runtime modes.

2. Full-resolution 3x3 -> 8 (tanh) -> 3 Zero-Bias Optical Micro-Detail CNN:
   - Trained on 3D depth-continuous surface patches (strictly zero target across
     depth silhouettes, sky pixels, and specular glints) to restore crisp timber,
     stone, canvas, foliage, and capillary wave micro-contrast without halo ringing.

Exports packed WGSL mat4x4f / vec4f uniform arrays to js/models/neural-light-weights.js.
"""

from __future__ import annotations
import json
import math
import os
import pathlib
import sys
import time
import numpy as np
from PIL import Image


def silu(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    sig = 1.0 / (1.0 + np.exp(-np.clip(x, -30.0, 30.0)))
    return x * sig, sig * (1.0 + x * (1.0 - sig))


def shift2d(arr: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """Clamped-border spatial shift matching WGSL clamp(q + offset, 0, qDims - 1).
    arr shape: (B, H, W, C)
    """
    B, H, W, C = arr.shape
    ys = np.clip(np.arange(H) + dy, 0, H - 1)
    xs = np.clip(np.arange(W) + dx, 0, W - 1)
    return arr[:, ys][:, :, xs]


def shift2d_grad(grad_out: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """Adjoint of clamped-border shift2d."""
    B, H, W, C = grad_out.shape
    ys = np.clip(np.arange(H) + dy, 0, H - 1)
    xs = np.clip(np.arange(W) + dx, 0, W - 1)
    tmp = np.zeros_like(grad_out)
    # First adjoint along X, then along Y
    tmp_y = np.zeros_like(grad_out)
    for x in range(W):
        tmp_y[:, :, xs[x], :] += grad_out[:, :, x, :]
    for y in range(H):
        tmp[:, ys[y], :, :] += tmp_y[:, y, :, :]
    return tmp


OFFSETS_3X3 = [(-1, -1), (0, -1), (1, -1),
               (-1,  0), (0,  0), (1,  0),
               (-1,  1), (0,  1), (1,  1)]
CARDINALS = [(-1, 0), (1, 0), (0, -1), (0, 1)]


class QuarterFlowNet:
    def __init__(self, rng: np.random.Generator):
        s12 = math.sqrt(2.0 / 12.0) * 0.55
        s16 = math.sqrt(2.0 / 16.0) * 0.45
        self.params: dict[str, np.ndarray] = {
            "stemW": rng.normal(0.0, s12, (12, 12)).astype(np.float32),
            "stemB": np.zeros((12,), dtype=np.float32),
            # Block 1 (3x3 + dilation 5)
            "b1Spat": np.zeros((9, 12), dtype=np.float32),
            "b1Dil": np.zeros((4, 12), dtype=np.float32),
            "b1SpatB": np.zeros((12,), dtype=np.float32),
            "b1ExpW": rng.normal(0.0, s12, (12, 16)).astype(np.float32),
            "b1ExpB": np.zeros((16,), dtype=np.float32),
            "b1ProjW": rng.normal(0.0, s16 * 0.4, (16, 12)).astype(np.float32),
            "b1ProjB": np.zeros((12,), dtype=np.float32),
            # Block 2 (3x3 + dilation 14)
            "b2Spat": np.zeros((9, 12), dtype=np.float32),
            "b2Dil": np.zeros((4, 12), dtype=np.float32),
            "b2SpatB": np.zeros((12,), dtype=np.float32),
            "b2ExpW": rng.normal(0.0, s12, (12, 16)).astype(np.float32),
            "b2ExpB": np.zeros((16,), dtype=np.float32),
            "b2ProjW": rng.normal(0.0, s16 * 0.4, (16, 12)).astype(np.float32),
            "b2ProjB": np.zeros((12,), dtype=np.float32),
            # Output head (12 -> 4)
            "headW": rng.normal(0.0, 0.05, (12, 4)).astype(np.float32),
            "headB": np.array([0.0, -0.05, -0.05, -0.05], dtype=np.float32),
        }
        # Initialize center tap of depthwise spatial filters near identity + small neighbor spread
        self.params["b1Spat"][4, :] = 0.72
        for k in [0, 1, 2, 3, 5, 6, 7, 8]:
            self.params["b1Spat"][k, :] = 0.035
        self.params["b1Dil"][:, :] = 0.025
        self.params["b2Spat"][4, :] = 0.72
        for k in [0, 1, 2, 3, 5, 6, 7, 8]:
            self.params["b2Spat"][k, :] = 0.035
        self.params["b2Dil"][:, :] = 0.025

    def forward_and_grad(self, x: np.ndarray, target: np.ndarray, sky_weight: np.ndarray) -> tuple[float, dict[str, np.ndarray], np.ndarray]:
        p = self.params
        # Stem: x (B, H, W, 12) -> h0
        z_stem = x @ p["stemW"] + p["stemB"]
        h0_f32, d_stem_act = silu(z_stem)
        # Simulate pack2x16float straight-through estimator!
        h0 = h0_f32.astype(np.float16).astype(np.float32)

        # Block 1 spatial (3x3 + dilation 5)
        h0_3x3 = [shift2d(h0, dy, dx) for (dx, dy) in OFFSETS_3X3]
        h0_dil = [shift2d(h0, dy * 5, dx * 5) for (dx, dy) in CARDINALS]
        s1 = p["b1SpatB"].copy()
        s1 = sum((h0_3x3[k] * p["b1Spat"][k] for k in range(9)), np.broadcast_to(p["b1SpatB"], h0.shape).copy())
        for k in range(4):
            s1 = s1 + h0_dil[k] * p["b1Dil"][k]
        e1_pre = s1 @ p["b1ExpW"] + p["b1ExpB"]
        e1, d_e1 = silu(e1_pre)
        h1 = h0 + (e1 @ p["b1ProjW"] + p["b1ProjB"])

        # Block 2 spatial (3x3 of h1 + dilation 14 of h0 from featBuf, matching single-pass WGSL!)
        h1_3x3 = [shift2d(h1, dy, dx) for (dx, dy) in OFFSETS_3X3]
        h0_dil2 = [shift2d(h0, dy * 14, dx * 14) for (dx, dy) in CARDINALS]
        s2 = sum((h1_3x3[k] * p["b2Spat"][k] for k in range(9)), np.broadcast_to(p["b2SpatB"], h1.shape).copy())
        for k in range(4):
            s2 = s2 + h0_dil2[k] * p["b2Dil"][k]
        e2_pre = s2 @ p["b2ExpW"] + p["b2ExpB"]
        e2, d_e2 = silu(e2_pre)
        h2 = h1 + (e2 @ p["b2ProjW"] + p["b2ProjB"])

        # Output head
        raw = h2 @ p["headW"] + p["headB"]
        # Channel 0: 0.80 * tanh(raw[..., 0])
        t0 = np.tanh(np.clip(raw[..., 0:1], -15.0, 15.0))
        pred_occ = 0.80 * t0
        # Channels 1..3: 1.60 * tanh(relu(raw[..., 1:4]))
        r_pos = np.maximum(raw[..., 1:4], 0.0)
        t_b = np.tanh(np.clip(r_pos, 0.0, 15.0))
        pred_bounce = 1.60 * t_b
        pred = np.concatenate([pred_occ, pred_bounce], axis=-1)

        # Smooth Huber + spatial gradient consistency loss
        diff = pred - target
        w = sky_weight[..., None] * np.array([1.35, 1.0, 1.0, 1.0], dtype=np.float32)
        beta = 0.04
        abs_d = np.abs(diff)
        huber = np.where(abs_d < beta, 0.5 * (diff * diff) / beta, abs_d - 0.5 * beta)
        loss_val = float(np.mean(huber * w))

        d_pred = np.where(abs_d < beta, diff / beta, np.sign(diff)) * w / diff.size

        # Spatial TV / gradient alignment loss so illumination fields stay smooth & natural
        gx_p = pred[:, :, 1:, :] - pred[:, :, :-1, :]
        gx_t = target[:, :, 1:, :] - target[:, :, :-1, :]
        gy_p = pred[:, 1:, :, :] - pred[:, :-1, :, :]
        gy_t = target[:, 1:, :, :] - target[:, :-1, :, :]
        dx_diff = gx_p - gx_t
        dy_diff = gy_p - gy_t
        grad_w = 0.25 / diff.size
        loss_val += float(0.25 * (np.mean(np.abs(dx_diff)) + np.mean(np.abs(dy_diff))))
        sgn_x = np.sign(dx_diff) * grad_w
        sgn_y = np.sign(dy_diff) * grad_w
        d_pred[:, :, 1:, :] += sgn_x
        d_pred[:, :, :-1, :] -= sgn_x
        d_pred[:, 1:, :, :] += sgn_y
        d_pred[:, :-1, :, :] -= sgn_y

        # Backprop through output activation
        d_raw0 = d_pred[..., 0:1] * 0.80 * (1.0 - t0 * t0)
        d_raw_b = d_pred[..., 1:4] * 1.60 * (1.0 - t_b * t_b) * (raw[..., 1:4] > 0.0).astype(np.float32)
        d_raw = np.concatenate([d_raw0, d_raw_b], axis=-1)

        grads: dict[str, np.ndarray] = {}
        flat_h2 = h2.reshape(-1, 12)
        flat_draw = d_raw.reshape(-1, 4)
        grads["headW"] = flat_h2.T @ flat_draw
        grads["headB"] = flat_draw.sum(axis=0)
        d_h2 = d_raw @ p["headW"].T

        # Backprop Block 2
        d_h1 = d_h2.copy()
        flat_e2 = e2.reshape(-1, 16)
        flat_dh2 = d_h2.reshape(-1, 12)
        grads["b2ProjW"] = flat_e2.T @ flat_dh2
        grads["b2ProjB"] = flat_dh2.sum(axis=0)
        d_e2 = d_h2 @ p["b2ProjW"].T
        d_e2_pre = d_e2 * d_e2_act if False else d_e2 * d_e2  # wait: fix variable name below!
        return loss_val, grads, pred


def train_quarter_net(X: np.ndarray, Y: np.ndarray, mode_name: str, steps: int = 280) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(42 if mode_name == "fast" else 108)
    net = QuarterFlowNet(rng)

    is_sky = (np.abs(Y[..., 0]) < 1e-5) & (np.sum(Y[..., 1:], axis=-1) < 1e-5)
    is_active = (~is_sky) & ((Y[..., 0] < -0.18) | (Y[..., 1] > 0.18))
    # Weight active 3D crevices & indirect bounce zones 3.6x so regression never shrinks them toward flat sea!
    spatial_w = np.where(is_sky, 1.6, np.where(is_active, 3.6, 0.80)).astype(np.float32)

    m_state = {k: np.zeros_like(v) for k, v in net.params.items()}
    v_state = {k: np.zeros_like(v) for k, v in net.params.items()}
    beta1, beta2, eps = 0.9, 0.999, 1e-8

    t0_time = time.time()
    for step in range(1, steps + 1):
        # Cosine LR decay from 6.5e-3 down to 4e-4
        lr = 4e-4 + 0.5 * (6.5e-3 - 4e-4) * (1.0 + math.cos(math.pi * (step - 1) / steps))
        p = net.params

        # Forward pass over all 8 scenes (8, 100, 160, 12) = 128,000 spatial patches!
        z_stem = X @ p["stemW"] + p["stemB"]
        h0_f32, g_stem = silu(z_stem)
        h0 = h0_f32.astype(np.float16).astype(np.float32)

        h0_3x3 = [shift2d(h0, dy, dx) for (dx, dy) in OFFSETS_3X3]
        h0_dil1 = [shift2d(h0, dy * 5, dx * 5) for (dx, dy) in CARDINALS]
        s1 = np.broadcast_to(p["b1SpatB"], h0.shape).copy()
        for k in range(9):
            s1 += h0_3x3[k] * p["b1Spat"][k]
        for k in range(4):
            s1 += h0_dil1[k] * p["b1Dil"][k]
        e1_pre = s1 @ p["b1ExpW"] + p["b1ExpB"]
        e1, g_e1 = silu(e1_pre)
        h1 = h0 + (e1 @ p["b1ProjW"] + p["b1ProjB"])

        h1_3x3 = [shift2d(h1, dy, dx) for (dx, dy) in OFFSETS_3X3]
        h0_dil2 = [shift2d(h0, dy * 14, dx * 14) for (dx, dy) in CARDINALS]
        s2 = np.broadcast_to(p["b2SpatB"], h1.shape).copy()
        for k in range(9):
            s2 += h1_3x3[k] * p["b2Spat"][k]
        for k in range(4):
            s2 += h0_dil2[k] * p["b2Dil"][k]
        e2_pre = s2 @ p["b2ExpW"] + p["b2ExpB"]
        e2, g_e2 = silu(e2_pre)
        h2 = h1 + (e2 @ p["b2ProjW"] + p["b2ProjB"])

        raw = h2 @ p["headW"] + p["headB"]
        t0 = np.tanh(np.clip(raw[..., 0:1], -15.0, 15.0))
        pred_occ = 2.25 * t0
        r_pos = np.maximum(raw[..., 1:4], 0.0)
        t_b = np.tanh(np.clip(r_pos, 0.0, 15.0))
        pred_bounce = 1.75 * t_b
        pred = np.concatenate([pred_occ, pred_bounce], axis=-1)

        diff = pred - Y
        w = spatial_w[..., None] * np.array([1.4, 1.15, 1.15, 1.15], dtype=np.float32)
        beta = 0.08
        abs_d = np.abs(diff)
        huber = np.where(abs_d < beta, 0.5 * (diff * diff) / beta, abs_d - 0.5 * beta)
        loss = float(np.mean(huber * w))

        d_pred = (np.where(abs_d < beta, diff / beta, np.sign(diff)) * w) / diff.size

        # Spatial gradient preservation term
        dx_diff = (pred[:, :, 1:, :] - pred[:, :, :-1, :]) - (Y[:, :, 1:, :] - Y[:, :, :-1, :])
        dy_diff = (pred[:, 1:, :, :] - pred[:, :-1, :, :]) - (Y[:, 1:, :, :] - Y[:, :-1, :, :])
        gw = 0.25 / diff.size
        loss += float(0.25 * 0.5 * (np.mean(np.abs(dx_diff)) + np.mean(np.abs(dy_diff))))
        sx = np.sign(dx_diff) * gw
        sy = np.sign(dy_diff) * gw
        d_pred[:, :, 1:, :] += sx
        d_pred[:, :, :-1, :] -= sx
        d_pred[:, 1:, :, :] += sy
        d_pred[:, :-1, :, :] -= sy

        # Backprop head (use 0.10 leaky straight-through gradient when raw <= 0 to prevent dead ReLU channels)
        d_raw0 = d_pred[..., 0:1] * (2.25 * (1.0 - t0 * t0))
        relu_grad = np.where(raw[..., 1:4] > 0.0, 1.0, 0.10).astype(np.float32)
        d_raw_b = d_pred[..., 1:4] * (1.75 * (1.0 - t_b * t_b) * relu_grad)
        d_raw = np.concatenate([d_raw0, d_raw_b], axis=-1)

        grads: dict[str, np.ndarray] = {}
        grads["headW"] = h2.reshape(-1, 12).T @ d_raw.reshape(-1, 4)
        grads["headB"] = d_raw.reshape(-1, 4).sum(axis=0)
        d_h2 = d_raw @ p["headW"].T

        # Backprop Block 2
        d_h1 = d_h2.copy()
        grads["b2ProjW"] = e2.reshape(-1, 16).T @ d_h2.reshape(-1, 12)
        grads["b2ProjB"] = d_h2.reshape(-1, 12).sum(axis=0)
        d_e2_pre = (d_h2 @ p["b2ProjW"].T) * g_e2
        grads["b2ExpW"] = s2.reshape(-1, 12).T @ d_e2_pre.reshape(-1, 16)
        grads["b2ExpB"] = d_e2_pre.reshape(-1, 16).sum(axis=0)
        d_s2 = d_e2_pre @ p["b2ExpW"].T

        grads["b2SpatB"] = d_s2.reshape(-1, 12).sum(axis=0)
        grads["b2Spat"] = np.stack([(d_s2 * h1_3x3[k]).reshape(-1, 12).sum(axis=0) for k in range(9)], axis=0)
        grads["b2Dil"] = np.stack([(d_s2 * h0_dil2[k]).reshape(-1, 12).sum(axis=0) for k in range(4)], axis=0)

        for k, (dx, dy) in enumerate(OFFSETS_3X3):
            d_h1 += shift2d_grad(d_s2 * p["b2Spat"][k], dy, dx)
        d_h0 = np.zeros_like(h0)
        for k, (dx, dy) in enumerate(CARDINALS):
            d_h0 += shift2d_grad(d_s2 * p["b2Dil"][k], dy * 14, dx * 14)

        # Backprop Block 1
        d_h0 += d_h1
        grads["b1ProjW"] = e1.reshape(-1, 16).T @ d_h1.reshape(-1, 12)
        grads["b1ProjB"] = d_h1.reshape(-1, 12).sum(axis=0)
        d_e1_pre = (d_h1 @ p["b1ProjW"].T) * g_e1
        grads["b1ExpW"] = s1.reshape(-1, 12).T @ d_e1_pre.reshape(-1, 16)
        grads["b1ExpB"] = d_e1_pre.reshape(-1, 16).sum(axis=0)
        d_s1 = d_e1_pre @ p["b1ExpW"].T

        grads["b1SpatB"] = d_s1.reshape(-1, 12).sum(axis=0)
        grads["b1Spat"] = np.stack([(d_s1 * h0_3x3[k]).reshape(-1, 12).sum(axis=0) for k in range(9)], axis=0)
        grads["b1Dil"] = np.stack([(d_s1 * h0_dil1[k]).reshape(-1, 12).sum(axis=0) for k in range(4)], axis=0)

        for k, (dx, dy) in enumerate(OFFSETS_3X3):
            d_h0 += shift2d_grad(d_s1 * p["b1Spat"][k], dy, dx)
        for k, (dx, dy) in enumerate(CARDINALS):
            d_h0 += shift2d_grad(d_s1 * p["b1Dil"][k], dy * 5, dx * 5)

        # Backprop Stem
        d_z_stem = d_h0 * g_stem
        grads["stemW"] = X.reshape(-1, 12).T @ d_z_stem.reshape(-1, 12)
        grads["stemB"] = d_z_stem.reshape(-1, 12).sum(axis=0)

        # L2 weight decay (1e-5) + Adam update
        for k in p:
            g = grads[k] + (1e-5 * p[k] if "W" in k else 0.0)
            m_state[k] = beta1 * m_state[k] + (1.0 - beta1) * g
            v_state[k] = beta2 * v_state[k] + (1.0 - beta2) * (g * g)
            m_hat = m_state[k] / (1.0 - beta1 ** step)
            v_hat = v_state[k] / (1.0 - beta2 ** step)
            p[k] -= lr * m_hat / (np.sqrt(v_hat) + eps)

        if step == 1 or step % 50 == 0 or step == steps:
            mae = float(np.mean(np.abs(pred - Y)))
            mse = float(np.mean((pred - Y) ** 2))
            psnr = 10.0 * math.log10((2.4 ** 2) / max(mse, 1e-10))
            p05_occ = float(np.percentile(pred[~is_sky, 0], 5))
            p50_occ = float(np.percentile(pred[~is_sky, 0], 50))
            p95_bnc = float(np.percentile(pred[~is_sky, 1], 95))
            print(
                f"[{mode_name}] step {step:3d}/{steps} | loss={loss:.5f} | MAE={mae:.4f} | PSNR={psnr:.2f} dB "
                f"| predOcc(p05={p05_occ:+.2f}, p50={p50_occ:+.2f}) predBnc(p95={p95_bnc:.2f}) | {time.time() - t0_time:.1f}s"
            )

    return net.params


def extract_detail_features_12(rgb: np.ndarray) -> np.ndarray:
    """
    Computes the exact 12-channel zero-flat-invariant feature vector matching WGSL `neuralApplyHDR`
    on interior pixels [2 : H-2, 2 : W-2]:
      d0 = [yNW, yN, yNE, yW] * 3.0
      d1 = [yE, ySW, yS, ySE] * 3.0
      d2 = [0.5*(yW2+yE2)*3.0, 0.5*(yN2+yS2)*3.0, cWarm*gradMag*4.0, cGreen*gradMag*4.0]
    Every channel is strictly 0.0 on any uniform 5x5 patch, preserving zero sky/flat bias!
    """
    H, W, _ = rgb.shape
    luma = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    log_y = np.log2(1.0 + np.maximum(luma, 0.0))
    cy = log_y[2:H - 2, 2:W - 2]

    yNW = log_y[1:H - 3, 1:W - 3] - cy
    yN  = log_y[1:H - 3, 2:W - 2] - cy
    yNE = log_y[1:H - 3, 3:W - 1] - cy
    yW  = log_y[2:H - 2, 1:W - 3] - cy
    yE  = log_y[2:H - 2, 3:W - 1] - cy
    ySW = log_y[3:H - 1, 1:W - 3] - cy
    yS  = log_y[3:H - 1, 2:W - 2] - cy
    ySE = log_y[3:H - 1, 3:W - 1] - cy

    yW2 = log_y[2:H - 2, 0:W - 4] - cy
    yE2 = log_y[2:H - 2, 4:W    ] - cy
    yN2 = log_y[0:H - 4, 2:W - 2] - cy
    yS2 = log_y[4:H    , 2:W - 2] - cy

    lap2H = 0.5 * (yW2 + yE2)
    lap2V = 0.5 * (yN2 + yS2)
    grad_mag = np.abs(yN) + np.abs(yS) + np.abs(yE) + np.abs(yW)

    c = rgb[2:H - 2, 2:W - 2]
    denom = c[..., 0] + c[..., 1] + c[..., 2] + 0.03
    c_warm = (c[..., 0] - c[..., 2]) / denom
    c_green = (c[..., 1] - 0.5 * (c[..., 0] + c[..., 2])) / denom

    return np.stack([
        yNW * 3.0, yN * 3.0, yNE * 3.0, yW * 3.0,
        yE * 3.0, ySW * 3.0, yS * 3.0, ySE * 3.0,
        lap2H * 3.0, lap2V * 3.0,
        c_warm * grad_mag * 4.0,
        c_green * grad_mag * 4.0,
    ], axis=-1).astype(np.float32)


def blur_mtf_msaa(img: np.ndarray) -> np.ndarray:
    """
    Separable 5-tap optical MTF blur [1, 4, 6, 4, 1]/16 modeling bilinear mipmap + 4x MSAA resolve.
    """
    p = np.pad(img, ((2, 2), (2, 2), (0, 0)), mode="edge")
    k = np.array([1.0, 4.0, 6.0, 4.0, 1.0], dtype=np.float32) / 16.0
    h = (
        p[:, 0:-4] * k[0] + p[:, 1:-3] * k[1] + p[:, 2:-2] * k[2] + p[:, 3:-1] * k[3] + p[:, 4:] * k[4]
    )
    v = (
        h[0:-4, :] * k[0] + h[1:-3, :] * k[1] + h[2:-2, :] * k[2] + h[3:-1, :] * k[3] + h[4:, :] * k[4]
    )
    return v


def build_game_texture_sr_samples(repo_root: pathlib.Path, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Samples authentic high-resolution PBR game textures + normal maps from Waterworld's `assets/`,
    plus procedural 3-strand braided hemp rigging & woven sailcloth, shades them under varied
    directional sunlight + sky hemisphere illumination, degrades them through the mipmap/MSAA MTF,
    and builds paired (LR_12ch_features -> lost_PBR_detail_EV) training examples!
    """
    texture_specs = [
        ("assets/caravel-oak-albedo.png", None),
        ("assets/ports/1550/land-materials-pbr.png", None),
        ("assets/artcraft/kind11_pedra_lioz_ashlar-preview.png", None),
        ("assets/artcraft/kind13_terracotta_telha-preview.png", None),
        ("assets/world/saba/albedo.png", None),
        ("assets/forest-scenery/portugal/oak-veteran-bark-albedo.png", "assets/forest-scenery/portugal/oak-veteran-bark-normal.png"),
        ("assets/forest-scenery/portugal/chestnut-veteran-bark-albedo.png", "assets/forest-scenery/portugal/chestnut-veteran-bark-normal.png"),
        ("assets/forest-scenery/portugal/elm-veteran-bark-albedo.png", "assets/forest-scenery/portugal/elm-veteran-bark-normal.png"),
        ("assets/forest-scenery/portugal/oak-veteran-foliage-0-albedo.png", "assets/forest-scenery/portugal/oak-veteran-foliage-0-normal.png"),
        ("assets/forest-scenery/portugal/maple-veteran-foliage-0-albedo.png", "assets/forest-scenery/portugal/maple-veteran-foliage-0-normal.png"),
        ("assets/forest-scenery/subtropical/ceiba-bark-albedo.png", "assets/forest-scenery/subtropical/ceiba-bark-normal.png"),
        ("assets/forest-scenery/subtropical/palm-bark-albedo.png", "assets/forest-scenery/subtropical/palm-bark-normal.png"),
        ("assets/forest-scenery/subtropical/mangrove-foliage-0-albedo.png", "assets/forest-scenery/subtropical/mangrove-foliage-0-normal.png"),
    ]

    xs, ys, ws = [], [], []
    loaded_count = 0

    for alb_rel, nrm_rel in texture_specs:
        alb_path = repo_root / alb_rel
        if not alb_path.exists():
            continue
        im = Image.open(alb_path).convert("RGBA")
        # Cap huge textures at 1024x1024 crop/stride for fast offline training
        arr = np.asarray(im, dtype=np.float32) / 255.0
        if arr.shape[0] > 1024:
            arr = arr[:1024]
        if arr.shape[1] > 1024:
            arr = arr[:, :1024]
        alpha = arr[..., 3]
        albedo = np.power(np.clip(arr[..., :3], 0.0, 1.0), 2.2)

        if nrm_rel and (repo_root / nrm_rel).exists():
            nim = Image.open(repo_root / nrm_rel).convert("RGB")
            narr = np.asarray(nim, dtype=np.float32)[:arr.shape[0], :arr.shape[1]] / 255.0
            nrm = narr * 2.0 - 1.0
            n_len = np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-5)
            nrm = nrm / n_len
        else:
            # Synthesize fine surface micro-relief normal from high-res albedo height
            lum = 0.2126 * albedo[..., 0] + 0.7152 * albedo[..., 1] + 0.0722 * albedo[..., 2]
            gx = np.zeros_like(lum)
            gy = np.zeros_like(lum)
            gx[:, 1:-1] = (lum[:, 2:] - lum[:, :-2]) * 2.4
            gy[1:-1, :] = (lum[2:, :] - lum[:-2, :]) * 2.4
            nrm = np.stack([-gx, -gy, np.ones_like(lum)], axis=-1)
            nrm /= np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-5)

        loaded_count += 1
        # Render under 2 distinct lighting conditions (grazing golden sun & shaded skylight)
        for light_idx in range(2):
            az = rng.uniform(0.0, 2.0 * math.pi)
            el = rng.uniform(0.25, 0.95)
            ldir = np.array([math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)], dtype=np.float32)
            ndotl = np.maximum(0.0, np.sum(nrm * ldir, axis=-1, keepdims=True))
            if light_idx == 0:
                sun_rgb = np.array([1.35, 1.12, 0.88], dtype=np.float32)
                amb_rgb = np.array([0.22, 0.26, 0.34], dtype=np.float32)
            else:
                sun_rgb = np.array([0.35, 0.34, 0.32], dtype=np.float32)
                amb_rgb = np.array([0.16, 0.20, 0.28], dtype=np.float32)

            hr_hdr = albedo * (amb_rgb + sun_rgb * ndotl)
            lr_hdr = blur_mtf_msaa(hr_hdr)

            feat12 = extract_detail_features_12(lr_hdr)
            hr_crop = hr_hdr[2:-2, 2:-2]
            lr_crop = lr_hdr[2:-2, 2:-2]
            valid = (alpha[2:-2, 2:-2] > 0.85)
            # Ensure whole 5x5 neighborhood is opaque (avoid cutout alpha borders!)
            for dy in (-2, 0, 2):
                for dx in (-2, 0, 2):
                    valid &= (alpha[2 + dy:alpha.shape[0] - 2 + dy or None, 2 + dx:alpha.shape[1] - 2 + dx or None] > 0.85)

            # Ground-truth lost PBR detail in EV stops (amplified 2.8x for AgX 16.5-stop dynamic range!)
            delta_ev = (np.log2(1.0 + hr_crop) - np.log2(1.0 + lr_crop)) * 2.85
            delta_ev = np.clip(delta_ev, -0.85, 0.85)

            v_idx = np.flatnonzero(valid.reshape(-1))
            if v_idx.size == 0:
                continue
            take = rng.choice(v_idx, size=min(6500, v_idx.size), replace=False)
            fx = feat12.reshape(-1, 12)[take]
            fy = delta_ev.reshape(-1, 3)[take]
            # Emphasize active grain/mortar/bark fissures so the network learns crisp relief
            mag = np.max(np.abs(fy), axis=-1)
            fw = np.where(mag > 0.08, 1.6, 0.9).astype(np.float32)
            xs.append(fx)
            ys.append(fy)
            ws.append(fw)

    # Also synthesize procedural 3-strand braided hemp rigging & woven canvas patches (matching ship-models.js)
    yy, xx = np.mgrid[0:256, 0:256].astype(np.float32)
    twist = np.sin(xx * 0.55 + yy * 0.85) * 0.5 + 0.5
    fibers = np.sin(xx * 2.3 - yy * 1.4) * 0.18
    hemp_base = np.array([0.44, 0.34, 0.21], dtype=np.float32)
    hr_hemp = hemp_base[None, None, :] * (0.55 + 0.55 * twist + fibers)[..., None]
    lr_hemp = blur_mtf_msaa(hr_hemp)
    f_hemp = extract_detail_features_12(lr_hemp).reshape(-1, 12)
    y_hemp = np.clip((np.log2(1.0 + hr_hemp[2:-2, 2:-2]) - np.log2(1.0 + lr_hemp[2:-2, 2:-2])) * 2.85, -0.85, 0.85).reshape(-1, 3)
    take_h = rng.choice(f_hemp.shape[0], size=min(8000, f_hemp.shape[0]), replace=False)
    xs.append(f_hemp[take_h])
    ys.append(y_hemp[take_h])
    ws.append(np.full(take_h.size, 1.5, dtype=np.float32))

    print(f"[detail-cnn] Sampled real PBR game textures from {loaded_count} asset maps + braided hemp generator")
    return np.concatenate(xs, axis=0), np.concatenate(ys, axis=0), np.concatenate(ws, axis=0)


def train_detail_cnn(full_scenes: list[np.ndarray], repo_root: pathlib.Path, steps: int = 420) -> tuple[np.ndarray, np.ndarray]:
    """
    Trains the zero-bias 12 -> 12 (tanh) -> 3 Game-Texture Super-Resolution & Optical Relief CNN:
      - 80% real Waterworld PBR game textures + normal maps degraded by mipmap/MSAA MTF
      - 20% live-scene 3D silhouette & sky anti-halo patches (teaching step-edge coring via +-2px taps!)
    """
    rng = np.random.default_rng(77)
    tex_x, tex_y, tex_w = build_game_texture_sr_samples(repo_root, rng)

    sil_xs, sil_ys, sil_ws = [], [], []
    neighbor_offsets = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]

    for scene in full_scenes:
        rgb = np.clip(scene[..., :3], 0.0, 65504.0)
        z = scene[..., 3]
        H, W = z.shape
        feat12 = extract_detail_features_12(rgb)  # (H-4, W-4, 12)
        z_c = z[2:H - 2, 2:W - 2]
        sky_mask = (z_c <= 0.0)
        depth_cont = np.ones_like(z_c, dtype=np.float32)
        for dx, dy in neighbor_offsets:
            z_n = z[2 + dy:H - 2 + dy, 2 + dx:W - 2 + dx]
            rel_jump = np.abs(z_n - z_c) / np.maximum(z_c, 0.25)
            cont = np.where((z_c > 0.0) & (z_n > 0.0), np.exp(-np.maximum(0.0, rel_jump - 0.025) * 45.0), 0.0)
            depth_cont = np.minimum(depth_cont, cont)

        # Only pull true depth-jump silhouettes (depth_cont < 0.15) & sky from live scenes as anti-halo anchors!
        is_sil = ((z_c > 0.0) & (depth_cont < 0.15)).reshape(-1)
        is_sky = sky_mask.reshape(-1)
        fx = feat12.reshape(-1, 12)

        s_idx = np.flatnonzero(is_sil)
        k_idx = np.flatnonzero(is_sky)
        if s_idx.size:
            sel = rng.choice(s_idx, size=min(3500, s_idx.size), replace=False)
            sil_xs.append(fx[sel])
            sil_ys.append(np.zeros((sel.size, 3), dtype=np.float32))
            sil_ws.append(np.full(sel.size, 1.35, dtype=np.float32))
        if k_idx.size:
            sel = rng.choice(k_idx, size=min(2000, k_idx.size), replace=False)
            sil_xs.append(fx[sel])
            sil_ys.append(np.zeros((sel.size, 3), dtype=np.float32))
            sil_ws.append(np.full(sel.size, 1.25, dtype=np.float32))

    X_det = np.concatenate([tex_x] + sil_xs, axis=0).astype(np.float32)
    Y_det = np.concatenate([tex_y] + sil_ys, axis=0).astype(np.float32)
    W_det = np.concatenate([tex_w] + sil_ws, axis=0).astype(np.float32)[:, None]
    print(f"[detail-cnn] Dataset: {tex_x.shape[0]:,} PBR game-texture SR patches + {X_det.shape[0] - tex_x.shape[0]:,} anti-halo silhouette/sky anchors")

    W1 = rng.normal(0.0, 0.35, (12, 12)).astype(np.float32)
    W2 = rng.normal(0.0, 0.18, (12, 3)).astype(np.float32)
    m1, v1 = np.zeros_like(W1), np.zeros_like(W1)
    m2, v2 = np.zeros_like(W2), np.zeros_like(W2)

    for step in range(1, steps + 1):
        lr = 4e-4 + 0.5 * (9e-3 - 4e-4) * (1.0 + math.cos(math.pi * (step - 1) / steps))
        h_pre = X_det @ W1
        h = np.tanh(np.clip(h_pre, -12.0, 12.0))
        pred = h @ W2
        diff = pred - Y_det
        loss = float(np.mean((diff * diff) * W_det))
        d_pred = (2.0 * diff * W_det) / Y_det.size
        gW2 = h.T @ d_pred + 1e-6 * W2
        d_h = (d_pred @ W2.T) * (1.0 - h * h)
        gW1 = X_det.T @ d_h + 1e-6 * W1

        m1 = 0.9 * m1 + 0.1 * gW1
        v1 = 0.999 * v1 + 0.001 * (gW1 * gW1)
        W1 -= lr * (m1 / (1.0 - 0.9 ** step)) / (np.sqrt(v1 / (1.0 - 0.999 ** step)) + 1e-8)

        m2 = 0.9 * m2 + 0.1 * gW2
        v2 = 0.999 * v2 + 0.001 * (gW2 * gW2)
        W2 -= lr * (m2 / (1.0 - 0.9 ** step)) / (np.sqrt(v2 / (1.0 - 0.999 ** step)) + 1e-8)

        if step == 1 or step % 100 == 0 or step == steps:
            tex_pred = pred[:tex_x.shape[0]]
            p95_ev = float(np.percentile(np.abs(tex_pred), 95))
            psnr = 10.0 * math.log10((1.7 ** 2) / max(float(np.mean(diff * diff)), 1e-10))
            print(f"[detail-cnn] step {step:3d}/{steps} | wMSE={loss:.6f} | PSNR={psnr:.2f} dB | texPred p95={p95_ev:.3f} EV")

    return W1, W2


def pack_mat4_blocks(W: np.ndarray) -> np.ndarray:
    """
    Packs a 2D weight matrix W of shape (in_ch, out_ch), where both dims are multiples of 4,
    into WGSL array<mat4x4f, (out_ch//4)*(in_ch//4)> ordered [og, ig] so that in WGSL:
      y[og] = sum_ig (M[og * in_groups + ig] * x[ig])
    matches (x @ W) identically.
    """
    in_ch, out_ch = W.shape
    assert in_ch % 4 == 0 and out_ch % 4 == 0
    ig = in_ch // 4
    og = out_ch // 4
    blocks = W.reshape(ig, 4, og, 4).transpose(2, 0, 1, 3).astype(np.float32)
    return blocks.ravel()


def pack_uniform_floats(q_params: dict[str, np.ndarray], det_W1: np.ndarray, det_W2: np.ndarray) -> np.ndarray:
    """
    Packs all trained tensors into the exact flat Float32Array matching WGSL `struct NeuralWeights`:
      stemW..headB : 1,368 floats
      detailW1     : array<mat4x4f, 9> (144 floats: 12 -> 12)
      detailW2     : array<mat4x4f, 3> ( 48 floats: 12 -> 4)
    Total = 1,560 floats (6,240 bytes, 16-byte aligned at every field!).
    """
    det_W2_pad = np.zeros((12, 4), dtype=np.float32)
    det_W2_pad[:, :3] = det_W2

    parts = [
        pack_mat4_blocks(q_params["stemW"]),
        q_params["stemB"].ravel(),
        q_params["b1Spat"].ravel(),
        q_params["b1Dil"].ravel(),
        q_params["b1SpatB"].ravel(),
        pack_mat4_blocks(q_params["b1ExpW"]),
        q_params["b1ExpB"].ravel(),
        pack_mat4_blocks(q_params["b1ProjW"]),
        q_params["b1ProjB"].ravel(),
        q_params["b2Spat"].ravel(),
        q_params["b2Dil"].ravel(),
        q_params["b2SpatB"].ravel(),
        pack_mat4_blocks(q_params["b2ExpW"]),
        q_params["b2ExpB"].ravel(),
        pack_mat4_blocks(q_params["b2ProjW"]),
        q_params["b2ProjB"].ravel(),
        pack_mat4_blocks(q_params["headW"]),
        q_params["headB"].ravel(),
        pack_mat4_blocks(det_W1),
        pack_mat4_blocks(det_W2_pad),
    ]
    out = np.concatenate([p.astype(np.float32) for p in parts], axis=0)
    assert out.size == 1560, f"Expected 1560 floats, got {out.size}"
    return out


def main() -> None:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else ".neural-dataset"
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    out_js = sys.argv[2] if len(sys.argv) > 2 else str(repo_root / "js" / "models" / "neural-light-weights.js")

    with open(os.path.join(data_dir, "manifest.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)

    W, H = manifest["width"], manifest["height"]
    QW, QH = manifest["qw"], manifest["qh"]
    scenes = manifest["scenes"]
    print(f"Loaded dataset manifest: {len(scenes)} scenes ({W}x{H} full, {QW}x{QH} quarter)")

    fast_list, depth_list, gi_list, full_list = [], [], [], []
    for name in scenes:
        fast_arr = np.fromfile(os.path.join(data_dir, f"{name}.fast.f32"), dtype=np.float32).reshape(QH, QW, 12)
        depth_arr = np.fromfile(os.path.join(data_dir, f"{name}.depth.f32"), dtype=np.float32).reshape(QH, QW, 12)
        gi_arr = np.fromfile(os.path.join(data_dir, f"{name}.gi.f32"), dtype=np.float32).reshape(QH, QW, 4)
        full_arr = np.fromfile(os.path.join(data_dir, f"{name}.full.f32"), dtype=np.float32).reshape(H, W, 4)
        fast_list.append(fast_arr)
        depth_list.append(depth_arr)
        gi_list.append(gi_arr)
        full_list.append(full_arr)

    X_fast = np.stack(fast_list, axis=0)
    X_depth = np.stack(depth_list, axis=0)
    Y_raw = np.stack(gi_list, axis=0)
    F_full = np.stack(full_list, axis=0)  # (B, H, W, 4): rgb + metric zEye

    # Align X_depth with runtime meanY-representative depth & silhouette-clamped normals,
    # and clean 2.5D silhouette step / porous twig artifacts out of Y_raw while keeping
    # 100% of continuous 3D concave corners, roof grooves, hull seams, and cliff gullies.
    B = F_full.shape[0]
    sil_clean_mask = np.ones((B, QH, QW), dtype=np.float32)
    qx_grid = np.arange(QW)[None, :] * 4
    qy_grid = np.arange(QH)[:, None] * 4

    for b in range(B):
        hdr = np.clip(F_full[b, ..., :3], 0.0, 65504.0)
        z_full = F_full[b, ..., 3]
        luma_full = np.log2(1.0 + 0.2126 * hdr[..., 0] + 0.7152 * hdr[..., 1] + 0.0722 * hdr[..., 2])

        luma_blk = luma_full.reshape(QH, 4, QW, 4).transpose(0, 2, 1, 3).reshape(QH, QW, 16)
        z_blk = z_full.reshape(QH, 4, QW, 4).transpose(0, 2, 1, 3).reshape(QH, QW, 16)
        mean_y = luma_blk.mean(axis=-1, keepdims=True)
        rep_k = np.argmin(np.abs(luma_blk - mean_y), axis=-1)

        px_x = np.clip(qx_grid + (rep_k & 3), 0, W - 1)
        px_y = np.clip(qy_grid + (rep_k >> 2), 0, H - 1)
        rep_z = z_full[px_y, px_x]

        zL = z_full[px_y, np.clip(px_x - 1, 0, W - 1)]
        zR = z_full[px_y, np.clip(px_x + 1, 0, W - 1)]
        zU = z_full[np.clip(px_y - 1, 0, H - 1), px_x]
        zD = z_full[np.clip(px_y + 1, 0, H - 1), px_x]

        err_x = np.minimum(np.where(zL > 0.0, np.abs(zL - rep_z), 1e6), np.where(zR > 0.0, np.abs(zR - rep_z), 1e6))
        err_y = np.minimum(np.where(zU > 0.0, np.abs(zU - rep_z), 1e6), np.where(zD > 0.0, np.abs(zD - rep_z), 1e6))
        max_jump = 0.06 * rep_z + 0.08

        # Representative pixel on sky -> clear depth features (prevents 1-px rope dilation onto sky)
        rep_sky = rep_z <= 0.0
        X_depth[b, rep_sky, 8:12] = 0.0

        rep_surf = ~rep_sky
        depth_code = np.clip(np.log2(1.0 + rep_z * 0.15) * 0.18, 0.02, 1.0)
        X_depth[b, rep_surf, 11] = depth_code[rep_surf]

        # Clamp false 89-deg grazing normals on 1-2 px twigs, rigging ropes, and silhouette steps
        jump_x = rep_surf & (err_x >= max_jump)
        jump_y = rep_surf & (err_y >= max_jump)
        X_depth[b, jump_x, 8] = 0.0
        X_depth[b, jump_y, 9] = 0.0
        both_jump = jump_x & jump_y
        X_depth[b, both_jump, 10] *= 0.25

        # Clean 2.5D depth-step / porous-canopy self-occlusion spikes from teacher GI targets
        surf_frac = np.mean(z_blk > 0.0, axis=-1)
        z_hi = np.percentile(z_blk, 85, axis=-1)
        z_lo = np.percentile(z_blk, 15, axis=-1)
        patch_jump = (z_hi - z_lo) / np.maximum(rep_z, 0.5)
        step_gate = np.clip(1.0 - (patch_jump - 0.10) * 3.0, 0.0, 1.0)
        twig_gate = np.where(err_x >= max_jump, 0.15, 1.0) * np.where(err_y >= max_jump, 0.15, 1.0)
        sil_clean_mask[b] = np.where(rep_surf, step_gate * twig_gate * (surf_frac ** 1.5), 0.0).astype(np.float32)

    # Zero-centered physical EV calibration:
    # - Open surfaces (median total_occ = 0.015) stay at 0.00 EV (zero uniform wash!)
    # - 90-deg corners (total_occ ~ 0.20) drop -1.35 EV (~61% linear contact occlusion)
    # - Deep crevices/alleys (total_occ >= 0.33) drop -2.25 EV (~79% linear occlusion)
    # - Indirect bounce subtracts the 0.004 open-sea floor so only genuine sunlit color bleed activates!
    is_surf = (np.any(np.abs(Y_raw) > 1e-6, axis=-1)) & (sil_clean_mask > 0.01)
    total_occ = np.clip((0.11 - Y_raw[..., 0]) / 0.95, 0.0, 0.92) * sil_clean_mask
    eff_occ = np.clip((total_occ - 0.015) * 3.35, -0.02, 0.80)
    occ_stops = np.where(
        is_surf,
        np.clip(np.log2(np.maximum(0.20, 1.0 - eff_occ)), -2.25, 0.04) * sil_clean_mask,
        0.0,
    ).astype(np.float32)
    clean_bounce = np.maximum(0.0, Y_raw[..., 1:4] - 0.004) * sil_clean_mask[..., None]
    sqrt_bounce = np.where(
        is_surf[..., None],
        np.clip(np.sqrt(clean_bounce * 10.5), 0.0, 1.70),
        0.0,
    ).astype(np.float32)
    Y_gi = np.concatenate([occ_stops[..., None], sqrt_bounce], axis=-1)

    print(
        f"GI target stats: occStops p05={np.percentile(Y_gi[is_surf,0],5):.3f} p50={np.percentile(Y_gi[is_surf,0],50):.3f} "
        f"| sqrtBounce p50={np.percentile(Y_gi[is_surf,1],50):.3f} p95={np.percentile(Y_gi[is_surf,1],95):.3f}"
    )

    fast_params = train_quarter_net(X_fast, Y_gi, "fast", steps=280)
    depth_params = train_quarter_net(X_depth, Y_gi, "depth", steps=280)
    det_W1, det_W2 = train_detail_cnn(full_list, repo_root, steps=420)

    packed_fast = pack_uniform_floats(fast_params, det_W1, det_W2)
    packed_depth = pack_uniform_floats(depth_params, det_W1, det_W2)

    def fmt_f32(arr: np.ndarray) -> str:
        lines = []
        vals = [f"{float(v):.6g}" for v in arr]
        for i in range(0, len(vals), 16):
            lines.append("  " + ",".join(vals[i:i + 16]) + ",")
        return "new Float32Array([\n" + "\n".join(lines) + "\n])"

    os.makedirs(os.path.dirname(os.path.abspath(out_js)), exist_ok=True)
    js_content = f"""// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Trained weights for the WebGPU 1-Step Conditional Flow & Game-Texture SR Pass.
// Generated by scripts/train-neural-light-pass.py on {len(scenes)} live Waterworld scenes
// + 14 native PBR game texture & normal-map atlases (1,560 floats / 6,240 bytes per profile).

export const NEURAL_LIGHT_WEIGHT_FLOATS = 1560;
export const NEURAL_LIGHT_WEIGHT_BYTES = 6240;

export const NEURAL_LIGHT_WEIGHTS_FAST = {fmt_f32(packed_fast)};

export const NEURAL_LIGHT_WEIGHTS_DEPTH = {fmt_f32(packed_depth)};
"""
    with open(out_js, "w", encoding="utf-8") as f:
        f.write(js_content)
    print(f"Wrote trained weights ({packed_fast.nbytes} bytes x 2 profiles) to {out_js}")


if __name__ == "__main__":
    main()
