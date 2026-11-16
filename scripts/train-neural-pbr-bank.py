#!/usr/bin/env python3
"""
Offline High-Resolution PBR Library & Neural Material Compression Trainer (NPBR v1).

Compiles a library of high-resolution (1K/2K/4K/8K) physical material maps into a compact,
WebGPU-native Dual-Band Neural PBR Material Bank (zero sampled textures, zero samplers):
  1. assets/neural-pbr/neural-pbr-latents.bin.gz
     - 12 canonical materials x 2 bands (64->1 meso + 64->1 golden-angle micro)
     - snorm8x4 packed u32 mip pyramids read via unpack4x8snorm in WGSL
     - Exact mip 6 == 0 identity convergence + Toksvig normal-variance roughness filtering
  2. js/models/neural-pbr-weights.js
     - 16-byte aligned uniform weights (mat4x4f shared 2-layer PReLU decoder + per-material
       spectral/subspace conditioning gates with exact f(0) == identity).

Supports BOTH:
  - Built-in 1024x1024 spectral/anatomical physical PBR synthesis fused with repository
    high-resolution assets (assets/caravel-oak-albedo.png, assets/ports/1550/land-materials-pbr.png)
  - External 2K/4K/8K scanned PBR folders via `--library-dir <dir>` (Poly Haven / AmbientCG /
    Megascans / TextureCraft naming conventions: *_albedo/diff/col, *_normal/nor_gl/nor_dx,
    *_rough/arm, *_ao).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import math
import os
import struct
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LATENT_OUT = ROOT / "assets" / "neural-pbr" / "neural-pbr-latents.bin.gz"
DEFAULT_WEIGHTS_OUT = ROOT / "js" / "models" / "neural-pbr-weights.js"

NPBR_MAGIC = 0x5242504E  # 'NPBR' little-endian
NPBR_VERSION = 1
MATERIAL_COUNT = 12
BASE_SIZE = 64
MIP_COUNT = 7  # 64, 32, 16, 8, 4, 2, 1 -> 5461 texels
RAW_WORDS_PER_BAND = sum((BASE_SIZE >> m) ** 2 for m in range(MIP_COUNT))  # 5461
WORDS_PER_BAND = 5464  # 32-byte aligned (5464 * 4 = 21856 B)
WORDS_PER_MATERIAL = WORDS_PER_BAND * 2  # 10928 words (43712 B)
TOTAL_LATENT_WORDS = MATERIAL_COUNT * WORDS_PER_MATERIAL  # 131136 words (524544 B)

LEAKY_SLOPE = 0.25
GOLDEN_MICRO_RATIO = 6.854101966249685  # 3 + sqrt(14.854...) irrational anti-tiling ratio
GOLDEN_ANGLE_RAD = 0.41151684606748806  # ~23.58 deg (cos=0.916515, sin=0.400000)
ROT_COS = math.cos(GOLDEN_ANGLE_RAD)
ROT_SIN = math.sin(GOLDEN_ANGLE_RAD)

# Output channel physical bounds matching js/wgsl/neural-pbr.js bit-for-bit:
#   outA = [albedoLogR, albedoLogG, albedoLogB, roughDelta]
#   outB = [normalX, normalY, cavityDelta, aniso]
OUT_SCALE = np.array(
    [0.52, 0.52, 0.52, 0.34, 0.62, 0.62, 0.36, 0.85], dtype=np.float32
)

MATERIAL_SPECS: List[Dict[str, object]] = [
    {
        "id": 0,
        "slug": "oak_timber",
        "label": "Quarter-sawn Iberian white oak planking & framing",
        "keywords": ["oak", "hull_wood", "timber", "wood_plank"],
        "meso_freq": 0.92,  # cycles/m (~1.09m cathedral meso patch + 15.9cm / 2.5mm micro pore!)
        "aniso_base": 0.58,
        "arch_layer": 0,
    },
    {
        "id": 1,
        "slug": "pine_spar",
        "label": "Oiled Baltic pine & spruce turned masts and spars",
        "keywords": ["pine", "spruce", "spar", "mast"],
        "meso_freq": 1.05,
        "aniso_base": 0.74,
        "arch_layer": 0,
    },
    {
        "id": 2,
        "slug": "weathered_deck",
        "label": "Holystoned scrubbed ship deck planking",
        "keywords": ["deck", "teak", "weathered_wood", "boardwalk"],
        "meso_freq": 0.98,
        "aniso_base": 0.50,
        "arch_layer": 0,
    },
    {
        "id": 3,
        "slug": "pedra_lioz",
        "label": "Coursed Pedra Lioz & fossiliferous limestone ashlar",
        "keywords": ["limestone", "lioz", "ashlar", "sandstone", "marble"],
        "meso_freq": 0.58,
        "aniso_base": 0.08,
        "arch_layer": 2,
    },
    {
        "id": 4,
        "slug": "lime_stucco",
        "label": "Troweled colonial limewash plaster & masonry",
        "keywords": ["stucco", "plaster", "limewash", "wall"],
        "meso_freq": 0.68,
        "aniso_base": 0.14,
        "arch_layer": 4,
    },
    {
        "id": 5,
        "slug": "terracotta_tile",
        "label": "Kiln-fired Iberian terracotta barrel roof tiles",
        "keywords": ["terracotta", "roof_tile", "telha", "clay", "brick"],
        "meso_freq": 0.82,
        "aniso_base": 0.36,
        "arch_layer": 6,
    },
    {
        "id": 6,
        "slug": "linen_canvas",
        "label": "Unbleached plain-weave flax sailcloth",
        "keywords": ["canvas", "linen", "sail", "fabric", "cloth"],
        "meso_freq": 1.35,
        "aniso_base": 0.44,
        "arch_layer": None,
    },
    {
        "id": 7,
        "slug": "braided_hemp",
        "label": "Hackled spun hemp & Stockholm-tarred cordage",
        "keywords": ["rope", "hemp", "cordage", "hawser", "twine"],
        "meso_freq": 1.85,
        "aniso_base": 0.70,
        "arch_layer": None,
    },
    {
        "id": 8,
        "slug": "cast_iron",
        "label": "Sand-cast ordnance iron & forged hardware",
        "keywords": ["cast_iron", "iron", "ordnance", "forged", "steel"],
        "meso_freq": 1.15,
        "aniso_base": 0.16,
        "arch_layer": 16,
    },
    {
        "id": 9,
        "slug": "patinated_copper",
        "label": "Cold-rolled hull copper sheathing & gilded bronze",
        "keywords": ["copper", "bronze", "brass", "verdigris", "metal_plate"],
        "meso_freq": 1.08,
        "aniso_base": 0.66,
        "arch_layer": None,
    },
    {
        "id": 10,
        "slug": "volcanic_basalt",
        "label": "Fractured coastal basalt cliffs & plagioclase rock",
        "keywords": ["basalt", "cliff", "rock", "granite", "volcanic"],
        "meso_freq": 0.44,
        "aniso_base": 0.10,
        "arch_layer": None,
    },
    {
        "id": 11,
        "slug": "cobble_soil",
        "label": "Foot-polished granite setts & packed harbour grit",
        "keywords": ["cobble", "setts", "paving", "gravel", "soil"],
        "meso_freq": 0.64,
        "aniso_base": 0.12,
        "arch_layer": 12,
    },
]


def periodic_fbm(
    res: int,
    rng: np.random.Generator,
    freq_min: float = 2.0,
    freq_max: float = 128.0,
    power: float = 1.65,
    aniso_xy: Tuple[float, float] = (1.0, 1.0),
) -> np.ndarray:
    """Exact seamless periodic spectral noise via 2D FFT."""
    ky = np.fft.fftfreq(res)[:, None] * res
    kx = np.fft.rfftfreq(res)[None, :] * res
    k = np.sqrt((kx / max(aniso_xy[0], 1e-3)) ** 2 + (ky / max(aniso_xy[1], 1e-3)) ** 2)
    mask = (k >= freq_min) & (k <= freq_max)
    amp = np.zeros_like(k, dtype=np.float64)
    amp[mask] = 1.0 / np.maximum(k[mask], 1.0) ** power
    phase = rng.uniform(0.0, 2.0 * np.pi, size=k.shape)
    spec = amp * (np.cos(phase) + 1j * np.sin(phase))
    spec[0, 0] = 0.0
    field = np.fft.irfft2(spec, s=(res, res)).astype(np.float32)
    std = float(np.std(field))
    return field / max(std, 1e-6)


def periodic_blur(arr: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0.05:
        return arr.copy()
    if arr.ndim == 2:
        return ndimage.gaussian_filter(arr, sigma=sigma, mode="wrap").astype(np.float32)
    out = np.empty_like(arr, dtype=np.float32)
    for c in range(arr.shape[-1]):
        out[..., c] = ndimage.gaussian_filter(arr[..., c], sigma=sigma, mode="wrap")
    return out


def height_to_normal_xy(height: np.ndarray, strength: float = 1.0) -> Tuple[np.ndarray, np.ndarray]:
    """Periodic central-difference height slope -> unit tangent normal (nx, ny)."""
    res = height.shape[0]
    dh_dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * (0.5 * res / 256.0) * strength
    dh_dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * (0.5 * res / 256.0) * strength
    inv_len = 1.0 / np.sqrt(dh_dx * dh_dx + dh_dy * dh_dy + 1.0)
    nx = (-dh_dx * inv_len).astype(np.float32)
    ny = (-dh_dy * inv_len).astype(np.float32)
    return nx, ny


def load_repo_oak_highpass(res: int) -> Optional[np.ndarray]:
    oak_path = ROOT / "assets" / "caravel-oak-albedo.png"
    if not oak_path.exists():
        oak_path = ROOT / "assets" / "caravel-oak-albedo.webp"
    if not oak_path.exists():
        return None
    img = Image.open(oak_path).convert("RGB").resize((res, res), Image.Resampling.LANCZOS)
    srgb = np.asarray(img, dtype=np.float32) / 255.0
    lin = np.power(np.clip(srgb, 1e-4, 1.0), 2.2)
    # Make tileable via cosine border cross-blend
    b = max(16, res // 12)
    w = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, b, dtype=np.float32))
    for axis in (0, 1):
        rolled = np.roll(lin, res // 2, axis=axis)
        shape = [1, 1, 1]
        shape[axis] = b
        wv = w.reshape(shape)
        if axis == 0:
            lin[:b] = lin[:b] * wv + rolled[:b] * (1.0 - wv)
            lin[-b:] = lin[-b:] * wv[::-1] + rolled[-b:] * (1.0 - wv[::-1])
        else:
            lin[:, :b] = lin[:, :b] * wv + rolled[:, :b] * (1.0 - wv)
            lin[:, -b:] = lin[:, -b:] * wv[:, ::-1] + rolled[:, -b:] * (1.0 - wv[:, ::-1])
    low = periodic_blur(lin, sigma=res / 18.0)
    log_hp = np.log2(np.clip(lin, 1e-4, 4.0) / np.clip(low, 1e-4, 4.0))
    log_hp -= np.mean(log_hp, axis=(0, 1), keepdims=True)
    return np.clip(log_hp, -0.5, 0.5).astype(np.float32)


def load_repo_arch_layers(res: int) -> Optional[np.ndarray]:
    atlas_path = ROOT / "assets" / "ports" / "1550" / "land-materials-pbr.png"
    if not atlas_path.exists():
        return None
    img = Image.open(atlas_path).convert("RGBA")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    if arr.shape[0] != 256 * 18 or arr.shape[1] != 256:
        return None
    layers = arr.reshape(18, 256, 256, 4)
    if res == 256:
        return layers
    out = np.empty((18, res, res, 4), dtype=np.float32)
    for i in range(18):
        pil = Image.fromarray(np.clip(layers[i] * 255.0, 0, 255).astype(np.uint8), mode="RGBA")
        out[i] = np.asarray(pil.resize((res, res), Image.Resampling.BICUBIC), dtype=np.float32) / 255.0
    return out


def try_load_external_material(lib_dir: Optional[Path], spec: Dict[str, object], res: int) -> Optional[np.ndarray]:
    """
    Ingests an external 2K/4K/8K PBR texture set from `--library-dir` when present.
    Returns (res, res, 8) target array:
      [albedoLogR, albedoLogG, albedoLogB, roughDelta, normalX, normalY, cavityDelta, aniso]
    """
    if lib_dir is None or not lib_dir.exists():
        return None
    slug = str(spec["slug"])
    keywords = [slug] + list(spec["keywords"])
    candidates: List[Path] = []
    for entry in sorted(lib_dir.rglob("*")):
        name_l = entry.name.lower()
        if any(k in name_l for k in keywords):
            candidates.append(entry)
    if not candidates:
        return None

    def find_map(map_tags: List[str]) -> Optional[Path]:
        for p in candidates:
            if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}:
                stem = p.stem.lower()
                if any(t in stem for t in map_tags):
                    return p
        for p in candidates:
            if p.is_dir():
                for sub in sorted(p.iterdir()):
                    if sub.is_file() and sub.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}:
                        if any(t in sub.stem.lower() for t in map_tags):
                            return sub
        return None

    albedo_p = find_map(["albedo", "diff", "basecolor", "color", "col"])
    normal_p = find_map(["normal", "nor_gl", "nor_dx", "nor", "nrm"])
    rough_p = find_map(["rough", "rgh", "arm", "orm"])
    ao_p = find_map(["ao", "ambientocclusion", "occ"])
    if albedo_p is None and normal_p is None:
        return None

    target = np.zeros((res, res, 8), dtype=np.float32)
    if albedo_p is not None:
        srgb = np.asarray(Image.open(albedo_p).convert("RGB").resize((res, res), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
        lin = np.power(np.clip(srgb, 1e-4, 1.0), 2.2)
        low = periodic_blur(lin, sigma=res / 14.0)
        log_hp = np.log2(np.clip(lin, 1e-4, 4.0) / np.clip(low, 1e-4, 4.0))
        log_hp -= np.mean(log_hp, axis=(0, 1), keepdims=True)
        target[..., 0:3] = np.clip(log_hp, -0.50, 0.50)

    if normal_p is not None:
        nrm = np.asarray(Image.open(normal_p).convert("RGB").resize((res, res), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
        nx = nrm[..., 0] * 2.0 - 1.0
        ny = nrm[..., 1] * 2.0 - 1.0
        if "nor_dx" in normal_p.stem.lower():
            ny = -ny
        nx -= np.mean(nx)
        ny -= np.mean(ny)
        target[..., 4] = np.clip(nx, -0.60, 0.60)
        target[..., 5] = np.clip(ny, -0.60, 0.60)
        # Estimate local orientation coherence for anisotropy from normal structure tensor
        jxx = periodic_blur(nx * nx, sigma=4.0)
        jyy = periodic_blur(ny * ny, sigma=4.0)
        coh = (jyy - jxx) / np.maximum(jxx + jyy + 1e-4, 1e-4)
        target[..., 7] = np.clip(coh * 0.75, -0.80, 0.80)
        target[..., 7] -= np.mean(target[..., 7])

    if rough_p is not None:
        r_img = Image.open(rough_p)
        r_arr = np.asarray(r_img.resize((res, res), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
        if r_arr.ndim == 3:
            stem_l = rough_p.stem.lower()
            r_ch = r_arr[..., 1] if ("arm" in stem_l or "orm" in stem_l) else r_arr[..., 0]
            if ("arm" in stem_l or "orm" in stem_l) and ao_p is None:
                ao_ch = r_arr[..., 0]
                target[..., 6] = np.clip(ao_ch - np.mean(ao_ch), -0.35, 0.12)
        else:
            r_ch = r_arr
        target[..., 3] = np.clip(r_ch - np.mean(r_ch), -0.32, 0.22)

    if ao_p is not None:
        ao_arr = np.asarray(Image.open(ao_p).convert("L").resize((res, res), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
        target[..., 6] = np.clip(ao_arr - np.mean(ao_arr), -0.35, 0.12)

    print(f"  [library] Loaded external high-res PBR set for {slug} from {lib_dir}")
    return target


def synthesize_master_pbr_library(res: int, lib_dir: Optional[Path] = None) -> List[np.ndarray]:
    """
    Builds 12 seamless high-resolution (res x res x 8) physical PBR detail targets:
      0..2: albedoLogDelta RGB  (zero-mean log2 reflectance detail)
      3   : roughDelta          (zero-mean micro-roughness: negative = glossy latewood/glaze/crystal/bare-metal!)
      4..5: normalX, normalY    (zero-mean tangent-space 3D micro-normal)
      6   : cavityDelta         (zero-mean micro-cavity AO offset)
      7   : aniso               (zero-mean fiber/brush/striation anisotropy)
     Note: constant baseline material anisotropy is stored separately in `uvScale` / shader logic, OR wait:
    if `aniso` is driven by the latent pyramid, wait — if `aniso` has zero mean at `mip 6`, what about
    close-up uniform grain anisotropy? Let's make sure close-up fiber ridges carry strong positive `aniso`
    AND we also store `baseAniso` in `NPBR.matMeso[m].w` or `uvScale`! Even better: let's store `baseAniso`
    directly in `NPBR` uniform metadata so directional fibers ALWAYS have true physical GGX anisotropy up close
    and smoothly fade to 0 with distance!
    """
    u = np.linspace(0.0, 1.0, res, endpoint=False, dtype=np.float32)[None, :]
    v = np.linspace(0.0, 1.0, res, endpoint=False, dtype=np.float32)[:, None]

    oak_hp = load_repo_oak_highpass(res)
    arch_layers = load_repo_arch_layers(res)

    targets: List[np.ndarray] = []

    for spec in MATERIAL_SPECS:
        mid = int(spec["id"])
        ext = try_load_external_material(lib_dir, spec, res)
        if ext is not None:
            targets.append(ext)
            continue

        rng = np.random.default_rng(155000 + mid * 7919)
        t = np.zeros((res, res, 8), dtype=np.float32)

        # Optional MaterialCraft high-frequency fusion
        arch_idx = spec["arch_layer"]
        arch_alb_hp = None
        arch_nrm = None
        arch_rgh_hp = None
        if arch_layers is not None and arch_idx is not None:
            even = arch_layers[int(arch_idx)]
            odd = arch_layers[int(arch_idx) + 1]
            lin = np.power(np.clip(even[..., :3], 1e-3, 1.0), 2.2)
            low = periodic_blur(lin, sigma=res / 10.0)
            arch_alb_hp = np.log2(np.clip(lin, 1e-4, 4.0) / np.clip(low, 1e-4, 4.0))
            arch_alb_hp -= np.mean(arch_alb_hp, axis=(0, 1), keepdims=True)
            arch_rgh_hp = even[..., 3] - np.mean(even[..., 3])
            anx = odd[..., 0] * 2.0 - 1.0
            any_ = odd[..., 1] * 2.0 - 1.0
            arch_nrm = (anx - np.mean(anx), any_ - np.mean(any_))

        # note: u = along primary tangent (grain / plank length), v = across grain!
        if mid == 0:  # oak_timber: quarter-sawn Iberian white oak (early/latewood rings, open tyloses vessels, bright medullary rays)
            warp = periodic_fbm(res, rng, 2, 14, 1.8, (3.5, 1.0)) * 0.08
            rings = np.sin(2.0 * np.pi * (v * 11.0 + warp))
            latewood = np.tanh(rings * 2.2) * 0.5 + 0.5  # dense glossy latewood bands
            pore_noise = periodic_fbm(res, rng, 18, res // 3, 1.35, (6.5, 1.0))
            vessels = np.clip(-pore_noise - 0.85, 0.0, 2.0) * (1.0 - latewood * 0.78)
            rays = np.clip(periodic_fbm(res, rng, 6, 48, 1.5, (2.8, 0.35)) - 1.15, 0.0, 1.5)
            fine_fibers = periodic_fbm(res, rng, 32, res // 2, 1.25, (8.0, 1.0)) * 0.06
            height = latewood * 0.32 - vessels * 0.52 + rays * 0.14 + fine_fibers
            nx, ny = height_to_normal_xy(height, strength=1.55)
            alb_scalar = (latewood - 0.5) * 0.22 - vessels * 0.34 + rays * 0.20 + fine_fibers * 0.8
            t[..., 0] = alb_scalar * 1.06
            t[..., 1] = alb_scalar * 0.98
            t[..., 2] = alb_scalar * 0.86
            if oak_hp is not None:
                # Rotate repo oak so grain runs along u (horizontal axis)
                oak_rot = np.swapaxes(oak_hp, 0, 1)
                t[..., 0:3] = 0.62 * t[..., 0:3] + 0.55 * oak_rot
            if arch_alb_hp is not None:
                t[..., 0:3] += 0.22 * arch_alb_hp
            # Latewood & medullary rays are dense & glossy (-0.22 rough); open earlywood pores are matte (+0.14)
            t[..., 3] = -(latewood - 0.5) * 0.26 - rays * 0.12 + vessels * 0.18
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -vessels * 0.26 + (latewood - 0.5) * 0.05
            t[..., 7] = (latewood - 0.5) * 0.35 + rays * 0.20 - vessels * 0.25

        elif mid == 1:  # pine_spar: oiled Baltic pine / spruce turned mast & yard (resinous golden latewood + linseed oil sheen)
            warp = periodic_fbm(res, rng, 2, 10, 1.9, (5.0, 1.0)) * 0.06
            rings = np.sin(2.0 * np.pi * (v * 15.0 + warp))
            resin_band = 1.0 / (1.0 + np.exp(-5.0 * (rings - 0.25)))
            tracheids = periodic_fbm(res, rng, 28, res // 2, 1.3, (10.0, 1.0))
            micro_check = np.clip(periodic_fbm(res, rng, 10, 64, 1.5, (7.0, 0.8)) - 1.55, 0.0, 1.2)
            height = resin_band * 0.28 + tracheids * 0.07 - micro_check * 0.45
            nx, ny = height_to_normal_xy(height, strength=1.35)
            t[..., 0] = -(resin_band - 0.35) * 0.24 + tracheids * 0.05 - micro_check * 0.28
            t[..., 1] = -(resin_band - 0.35) * 0.30 + tracheids * 0.05 - micro_check * 0.30
            t[..., 2] = -(resin_band - 0.35) * 0.38 + tracheids * 0.04 - micro_check * 0.32
            # Oiled resin bands gleam sharply in raking sun (-0.26 roughDelta)!
            t[..., 3] = -(resin_band - 0.35) * 0.32 + micro_check * 0.20 - np.abs(tracheids) * 0.03
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -micro_check * 0.28
            t[..., 7] = (resin_band - 0.35) * 0.42 - micro_check * 0.30

        elif mid == 2:  # weathered_deck: holystoned scrubbed silver-bleached deck planking (raised hard latewood ridges, eroded soft earlywood)
            warp = periodic_fbm(res, rng, 2, 16, 1.75, (4.2, 1.0)) * 0.07
            grain = np.sin(2.0 * np.pi * (v * 14.0 + warp))
            ridge = np.tanh(grain * 2.0) * 0.5 + 0.5
            sand_scrub = periodic_fbm(res, rng, 24, res // 2, 1.25, (5.5, 1.2))
            splinter_pore = np.clip(-sand_scrub - 1.05, 0.0, 1.6) * (1.0 - ridge * 0.65)
            height = ridge * 0.36 + sand_scrub * 0.06 - splinter_pore * 0.38
            nx, ny = height_to_normal_xy(height, strength=1.45)
            bleach = (ridge - 0.5) * 0.16 + sand_scrub * 0.05 - splinter_pore * 0.26
            t[..., 0] = bleach * 0.94
            t[..., 1] = bleach * 0.98
            t[..., 2] = bleach * 1.06  # sun/salt-bleached cool silver highlight on scrubbed ridges
            if oak_hp is not None:
                t[..., 0:3] += 0.32 * np.swapaxes(oak_hp, 0, 1)
            t[..., 3] = -(ridge - 0.5) * 0.22 + splinter_pore * 0.16
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -splinter_pore * 0.24
            t[..., 7] = (ridge - 0.5) * 0.32

        elif mid == 3:  # pedra_lioz: Portuguese fossiliferous Pedra Lioz limestone (calcite crystal facets, stylolite veins, shell vugs)
            cryst_a = periodic_fbm(res, rng, 16, res // 2, 1.15, (1.0, 1.0))
            cryst_b = periodic_fbm(res, rng, 8, 96, 1.45, (1.2, 0.9))
            stylolite = np.exp(-((periodic_fbm(res, rng, 3, 28, 1.6, (2.2, 0.8))) ** 2) * 28.0)
            vugs = np.clip(-periodic_fbm(res, rng, 12, 120, 1.35) - 1.35, 0.0, 1.5)
            calcite_sparkle = np.clip(cryst_a - 1.1, 0.0, 1.5)
            height = cryst_b * 0.22 + cryst_a * 0.10 - stylolite * 0.28 - vugs * 0.55
            nx, ny = height_to_normal_xy(height, strength=1.65)
            tone = cryst_b * 0.08 + calcite_sparkle * 0.14 - stylolite * 0.18 - vugs * 0.30
            t[..., 0] = tone * 1.04
            t[..., 1] = tone * 1.00
            t[..., 2] = tone * 0.92
            if arch_alb_hp is not None:
                t[..., 0:3] = 0.65 * t[..., 0:3] + 0.45 * arch_alb_hp
            # Cleaved calcite crystal faces glint sharply (-0.24 rough), vugs stay dusty matte (+0.14)
            t[..., 3] = -calcite_sparkle * 0.24 + vugs * 0.16 + stylolite * 0.08
            t[..., 4], t[..., 5] = nx, ny
            if arch_nrm is not None:
                t[..., 4] = 0.7 * t[..., 4] + 0.3 * arch_nrm[0]
                t[..., 5] = 0.7 * t[..., 5] + 0.3 * arch_nrm[1]
            t[..., 6] = -vugs * 0.28 - stylolite * 0.10

        elif mid == 4:  # lime_stucco: hand-troweled colonial limewash plaster (sweeping trowel arcs, sand grit, hairline craze cracks)
            trowel = periodic_fbm(res, rng, 3, 22, 1.75, (1.8, 1.1))
            burnish = np.tanh(trowel * 1.6)
            sand_grit = periodic_fbm(res, rng, 36, res // 2, 1.05, (1.0, 1.0))
            craze_f = periodic_fbm(res, rng, 5, 44, 1.5)
            craze = np.exp(-(craze_f ** 2) * 65.0) * np.clip(periodic_fbm(res, rng, 2, 12, 1.8) + 0.4, 0.0, 1.0)
            pinholes = np.clip(-sand_grit - 1.5, 0.0, 1.4)
            height = burnish * 0.24 + sand_grit * 0.07 - craze * 0.36 - pinholes * 0.32
            nx, ny = height_to_normal_xy(height, strength=1.35)
            alb = burnish * 0.07 + sand_grit * 0.04 - craze * 0.22 - pinholes * 0.18
            t[..., 0] = alb * 1.02
            t[..., 1] = alb * 1.00
            t[..., 2] = alb * 0.95
            if arch_alb_hp is not None:
                t[..., 0:3] += 0.30 * arch_alb_hp
            # Steel-trowel burnished lime skin has a subtle satin calcite sheen (-0.18 rough)
            t[..., 3] = -np.clip(burnish, 0.0, 1.0) * 0.20 + craze * 0.14 + np.abs(sand_grit) * 0.05
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -craze * 0.22 - pinholes * 0.20
            t[..., 7] = burnish * 0.22

        elif mid == 5:  # terracotta_tile: kiln-fired Iberian barrel telha (vitrified kiln glaze patches, grog temper grit, extrusion striae)
            striae = periodic_fbm(res, rng, 14, 120, 1.35, (4.5, 1.0))
            kiln_vit = periodic_fbm(res, rng, 2, 16, 1.8, (1.3, 1.0))
            glaze = 1.0 / (1.0 + np.exp(-3.2 * (kiln_vit - 0.15)))
            grog = np.clip(periodic_fbm(res, rng, 28, res // 2, 1.1) - 1.2, 0.0, 1.5)
            spall_pit = np.clip(-periodic_fbm(res, rng, 10, 80, 1.4) - 1.4, 0.0, 1.4)
            height = glaze * 0.18 + striae * 0.09 + grog * 0.16 - spall_pit * 0.42
            nx, ny = height_to_normal_xy(height, strength=1.45)
            t[..., 0] = (glaze - 0.45) * 0.14 + grog * 0.10 - spall_pit * 0.22 + striae * 0.04
            t[..., 1] = (glaze - 0.45) * 0.08 + grog * 0.12 - spall_pit * 0.20 + striae * 0.04
            t[..., 2] = (glaze - 0.45) * 0.04 + grog * 0.14 - spall_pit * 0.18 + striae * 0.03
            if arch_alb_hp is not None:
                t[..., 0:3] += 0.32 * arch_alb_hp
            # Vitrified kiln-fired clay reflects the sky brightly (-0.26 rough)!
            t[..., 3] = -(glaze - 0.45) * 0.30 + grog * 0.12 + spall_pit * 0.16
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -spall_pit * 0.26
            t[..., 7] = striae * 0.24

        elif mid == 6:  # linen_canvas: unbleached plain-weave flax sailcloth (crisp over-under warp/weft crowns, flax slubs, inter-yarn AO)
            n_threads = 32.0
            slub_u = 1.0 + 0.22 * periodic_fbm(res, rng, 4, 32, 1.6, (1.0, 6.0))
            slub_v = 1.0 + 0.22 * periodic_fbm(res, rng, 4, 32, 1.6, (6.0, 1.0))
            wu = np.sin(2.0 * np.pi * u * n_threads)
            wv = np.sin(2.0 * np.pi * v * n_threads)
            # Plain weave: warp crowns where sin(u)*sin(v) alternates
            warp_crown = np.clip(np.cos(np.pi * (u * n_threads * 2.0)), -1.0, 1.0) * 0.5 + 0.5
            weft_crown = np.clip(np.cos(np.pi * (v * n_threads * 2.0)), -1.0, 1.0) * 0.5 + 0.5
            over_under = np.sin(2.0 * np.pi * u * n_threads) * np.sin(2.0 * np.pi * v * n_threads)
            yarn_top = np.maximum(warp_crown * slub_u * (0.65 + 0.35 * over_under), weft_crown * slub_v * (0.65 - 0.35 * over_under))
            interstice = np.clip(1.0 - yarn_top * 1.25, 0.0, 1.0)
            fibrils = periodic_fbm(res, rng, 40, res // 2, 1.15, (2.5, 2.5)) * 0.06
            height = yarn_top * 0.42 - interstice * 0.30 + fibrils
            nx, ny = height_to_normal_xy(height, strength=1.65)
            flax_var = periodic_fbm(res, rng, 3, 28, 1.6, (1.5, 4.0)) * 0.09
            alb = (yarn_top - 0.55) * 0.26 - interstice * 0.28 + flax_var + fibrils * 0.5
            t[..., 0] = alb * 1.02
            t[..., 1] = alb * 1.00
            t[..., 2] = alb * 0.93
            t[..., 3] = -(yarn_top - 0.55) * 0.14 + interstice * 0.14
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -interstice * 0.32
            t[..., 7] = over_under * 0.55  # alternates warp vs weft tangent anisotropy!

        elif mid == 7:  # braided_hemp: 3-strand Z-laid hackled hemp & Stockholm pine-tar resin glaze
            strand_phase = 2.0 * np.pi * (u * 6.0 + v * 3.0)
            strand_u = (strand_phase / (2.0 * np.pi)) % 1.0 - 0.5
            crown = np.sqrt(np.maximum(0.08, 1.0 - 3.4 * strand_u * strand_u))
            valley = np.clip(np.abs(strand_u) * 2.4 - 0.65, 0.0, 1.0)
            ply = np.sin(2.0 * np.pi * (u * 26.0 - v * 11.0)) * 0.14
            bast = periodic_fbm(res, rng, 28, res // 2, 1.2, (5.0, 1.5)) * 0.09
            tar_glaze = np.clip(crown * (0.6 + 0.4 * periodic_fbm(res, rng, 4, 24, 1.6)) - 0.35, 0.0, 1.0)
            height = crown * 0.48 + ply + bast - valley * 0.36
            nx, ny = height_to_normal_xy(height, strength=1.70)
            alb = (crown - 0.65) * 0.34 + ply * 0.4 + bast * 0.6 - valley * 0.32 - tar_glaze * 0.10
            t[..., 0] = alb * 1.05
            t[..., 1] = alb * 0.98
            t[..., 2] = alb * 0.86
            # Pine-tar resin on strand crowns gives a rich waxy sheen (-0.22 rough)
            t[..., 3] = -tar_glaze * 0.24 + valley * 0.18
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -valley * 0.34
            t[..., 7] = (crown - 0.6) * 0.45

        elif mid == 8:  # cast_iron: sand-cast ordnance iron & forged hardware (sand mold craters, oxide crust vs bright bare-iron ridges)
            mold_coarse = periodic_fbm(res, rng, 6, 48, 1.45)
            sand_pits = np.clip(-periodic_fbm(res, rng, 22, res // 2, 1.15) - 1.10, 0.0, 1.8)
            bare_ridge = 1.0 / (1.0 + np.exp(-4.5 * (mold_coarse - 0.65))) * (1.0 - np.clip(sand_pits, 0.0, 1.0))
            forge_marks = periodic_fbm(res, rng, 10, 72, 1.4, (2.2, 1.0)) * 0.08
            height = mold_coarse * 0.18 + bare_ridge * 0.20 + forge_marks - sand_pits * 0.48
            nx, ny = height_to_normal_xy(height, strength=1.60)
            # Bare iron peaks are brighter metallic grey (+0.32 log albedo) & smooth (-0.30 rough); rust/sand pits are dark matte
            t[..., 0] = bare_ridge * 0.30 - sand_pits * 0.20 + mold_coarse * 0.05
            t[..., 1] = bare_ridge * 0.32 - sand_pits * 0.24 + mold_coarse * 0.05
            t[..., 2] = bare_ridge * 0.35 - sand_pits * 0.28 + mold_coarse * 0.05
            t[..., 3] = -bare_ridge * 0.32 + sand_pits * 0.16
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -sand_pits * 0.28
            t[..., 7] = bare_ridge * 0.24

        elif mid == 9:  # patinated_copper: cold-rolled copper hull sheathing & gilded bronze (mill roll striations + crystalline verdigris)
            mill_striae = periodic_fbm(res, rng, 18, res // 2, 1.25, (9.0, 1.0))
            hammer = periodic_fbm(res, rng, 3, 18, 1.8, (1.4, 1.1))
            verdigris_seed = periodic_fbm(res, rng, 5, 42, 1.45)
            verdigris = np.clip(verdigris_seed - 0.85, 0.0, 1.4)
            polish = np.clip(1.0 - verdigris * 1.4, 0.0, 1.0) * (0.5 + 0.5 * np.tanh(hammer))
            height = hammer * 0.16 + mill_striae * 0.08 + verdigris * 0.26
            nx, ny = height_to_normal_xy(height, strength=1.35)
            t[..., 0] = polish * 0.18 - verdigris * 0.28 + mill_striae * 0.05
            t[..., 1] = polish * 0.14 + verdigris * 0.18 + mill_striae * 0.05
            t[..., 2] = polish * 0.10 + verdigris * 0.14 + mill_striae * 0.04
            t[..., 3] = -polish * 0.28 + verdigris * 0.22
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -verdigris * 0.14
            t[..., 7] = polish * 0.48 - verdigris * 0.30

        elif mid == 10:  # volcanic_basalt: fractured coastal basalt & cliff rock (sharp conchoidal cleavage, plagioclase phenocrysts, vesicles)
            cleave_a = periodic_fbm(res, rng, 4, 36, 1.55, (1.6, 1.0))
            cleave_b = periodic_fbm(res, rng, 8, 72, 1.40, (1.0, 1.6))
            ridge = np.abs(cleave_a - cleave_b * 0.65)
            vesicles = np.clip(-periodic_fbm(res, rng, 18, res // 2, 1.15) - 1.30, 0.0, 1.7)
            phenocryst = np.clip(periodic_fbm(res, rng, 24, res // 2, 1.10) - 1.45, 0.0, 1.5)
            fissure = np.exp(-(cleave_a ** 2) * 45.0)
            height = ridge * 0.34 + phenocryst * 0.12 - vesicles * 0.52 - fissure * 0.40
            nx, ny = height_to_normal_xy(height, strength=1.75)
            alb = (ridge - 0.6) * 0.14 + phenocryst * 0.26 - vesicles * 0.30 - fissure * 0.26
            t[..., 0] = alb * 0.98
            t[..., 1] = alb * 1.00
            t[..., 2] = alb * 1.05
            t[..., 3] = -phenocryst * 0.24 - np.clip(ridge - 0.8, 0.0, 1.0) * 0.14 + vesicles * 0.16
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -vesicles * 0.30 - fissure * 0.24

        else:  # 11: cobble_soil: foot-polished granite setts, quartz/mica sparkle & recessed grit joints
            # Jittered Voronoi-like sett facets on a periodic 6x6 lattice + fine mineral crystal grit
            n_cells = 6
            best_d1 = np.full((res, res), 99.0, dtype=np.float32)
            best_d2 = np.full((res, res), 99.0, dtype=np.float32)
            stone_tone = np.zeros((res, res), dtype=np.float32)
            centers = rng.uniform(0.15, 0.85, size=(n_cells, n_cells, 2)).astype(np.float32)
            tones = rng.uniform(-1.0, 1.0, size=(n_cells, n_cells)).astype(np.float32)
            gu = u * n_cells
            gv = v * n_cells
            iu = np.floor(gu).astype(np.int32)
            iv = np.floor(gv).astype(np.int32)
            for dv_off in (-1, 0, 1):
                for du_off in (-1, 0, 1):
                    cu = (iu + du_off) % n_cells
                    cv = (iv + dv_off) % n_cells
                    px = (iu + du_off) + centers[cv, cu, 0] - gu
                    py = (iv + dv_off) + centers[cv, cu, 1] - gv
                    d = np.sqrt(px * px + py * py)
                    swap = d < best_d1
                    best_d2 = np.where(swap, best_d1, np.minimum(best_d2, d))
                    best_d1 = np.where(swap, d, best_d1)
                    stone_tone = np.where(swap, tones[cv, cu], stone_tone)
            edge = np.clip((best_d2 - best_d1) * 2.8, 0.0, 1.0)
            crown = np.tanh(edge * 2.2)
            mica = np.clip(periodic_fbm(res, rng, 32, res // 2, 1.05) - 1.30, 0.0, 1.6)
            grit = periodic_fbm(res, rng, 18, res // 2, 1.25)
            height = crown * 0.44 + grit * 0.08 * (1.0 - crown * 0.5) + mica * 0.06
            nx, ny = height_to_normal_xy(height, strength=1.65)
            alb = (crown - 0.65) * 0.28 + stone_tone * 0.11 * crown + mica * 0.18 + grit * 0.06 * (1.0 - crown)
            t[..., 0] = alb * 1.02
            t[..., 1] = alb * 1.00
            t[..., 2] = alb * 0.97
            if arch_alb_hp is not None:
                t[..., 0:3] = 0.72 * t[..., 0:3] + 0.32 * arch_alb_hp
            # Foot-worn granite sett crowns gleam smoothly (-0.26 rough); sandy joints stay matte (+0.16)
            t[..., 3] = -crown * 0.24 - mica * 0.14 + (1.0 - crown) * 0.18
            t[..., 4], t[..., 5] = nx, ny
            t[..., 6] = -(1.0 - crown) * 0.30

        # Enforce strict zero spatial mean on every channel so far-field average == identity!
        t -= np.mean(t, axis=(0, 1), keepdims=True)
        for ch in range(8):
            lim = float(OUT_SCALE[ch]) * 0.96
            t[..., ch] = np.clip(t[..., ch], -lim, lim)
        t -= np.mean(t, axis=(0, 1), keepdims=True)
        targets.append(t.astype(np.float32))

    return targets


def build_prefiltered_mip_targets(
    master: np.ndarray,
    mip_count: int = MIP_COUNT,
    base_full: Optional[np.ndarray] = None,
) -> List[np.ndarray]:
    """
    Downsamples (res, res, 8) physical target into 64, 32, 16, 8, 4, 2, 1 mip targets,
    applying physical Toksvig normal-variance -> roughness broadening as micro-normals
    become sub-texel, while smoothly tapering amplitude toward exact 0 at mip 6 (1x1).
    """
    mips: List[np.ndarray] = []
    res = master.shape[0]
    full_ref = base_full if base_full is not None else master
    base_n_energy = full_ref[..., 4] ** 2 + full_ref[..., 5] ** 2
    mips.append(master)
    for m in range(1, mip_count):
        if m == mip_count - 1:
            mips.append(np.zeros((1, 1, 8), dtype=np.float32))
            continue
        sigma = (2.0 ** m) * (res / 512.0) * 0.85
        filtered = periodic_blur(master, sigma=sigma)
        # Toksvig variance: unresolved normal energy broadens specular roughness, then fades by mip 5
        mean_n_energy = filtered[..., 4] ** 2 + filtered[..., 5] ** 2
        lost_var = np.maximum(0.0, periodic_blur(base_n_energy, sigma=sigma) - mean_n_energy)
        toksvig_rough = np.sqrt(lost_var) * 0.22 * (1.0 - m / float(mip_count - 1))
        filtered[..., 3] = np.clip(filtered[..., 3] + toksvig_rough - np.mean(toksvig_rough), -0.32, 0.22)
        # Smooth continuous envelope so mip 5 gently hands off to mip 6 == 0
        taper = math.cos(0.5 * math.pi * (m / float(mip_count - 1))) ** 0.85
        filtered *= taper
        filtered -= np.mean(filtered, axis=(0, 1), keepdims=True)
        mips.append(filtered.astype(np.float32))
    return mips


class AdamState:
    def __init__(self, params: Dict[str, np.ndarray]):
        self.m = {k: np.zeros_like(v, dtype=np.float32) for k, v in params.items()}
        self.v = {k: np.zeros_like(v, dtype=np.float32) for k, v in params.items()}
        self.t = 0

    def step(
        self,
        params: Dict[str, np.ndarray],
        grads: Dict[str, np.ndarray],
        lr: float,
        b1: float = 0.9,
        b2: float = 0.995,
        eps: float = 1e-8,
    ) -> None:
        self.t += 1
        bc1 = 1.0 - b1 ** self.t
        bc2 = 1.0 - b2 ** self.t
        for k, g in grads.items():
            self.m[k] = b1 * self.m[k] + (1.0 - b1) * g
            self.v[k] = b2 * self.v[k] + (1.0 - b2) * (g * g)
            m_hat = self.m[k] / bc1
            v_hat = self.v[k] / bc2
            params[k] -= lr * m_hat / (np.sqrt(v_hat) + eps)


def ste_quantize_snorm8(z: np.ndarray) -> np.ndarray:
    z_clip = np.clip(z, -1.0, 1.0)
    return np.round(z_clip * 127.0) / 127.0


def bilinear_gather_and_scatter_prep(uv: np.ndarray, size: int):
    """Precomputes wrapped bilinear indices & weights matching WGSL sampleNeuralPbrBand."""
    coord = uv * float(size) - 0.5
    fl = np.floor(coord)
    f = (coord - fl).astype(np.float32)
    i0 = (fl.astype(np.int32)) % size
    i1 = (i0 + 1) % size
    fx = f[:, 0:1]
    fy = f[:, 1:2]
    w00 = (1.0 - fx) * (1.0 - fy)
    w10 = fx * (1.0 - fy)
    w01 = (1.0 - fx) * fy
    w11 = fx * fy
    idx00 = i0[:, 1] * size + i0[:, 0]
    idx10 = i0[:, 1] * size + i1[:, 0]
    idx01 = i1[:, 1] * size + i0[:, 0]
    idx11 = i1[:, 1] * size + i1[:, 0]
    return (idx00, idx10, idx01, idx11), (w00, w10, w01, w11)


def bilinear_sample(grid_flat: np.ndarray, idxs, ws) -> np.ndarray:
    idx00, idx10, idx01, idx11 = idxs
    w00, w10, w01, w11 = ws
    return (
        grid_flat[idx00] * w00
        + grid_flat[idx10] * w10
        + grid_flat[idx01] * w01
        + grid_flat[idx11] * w11
    )


def bilinear_scatter_grad(grad_sample: np.ndarray, size: int, idxs, ws) -> np.ndarray:
    idx00, idx10, idx01, idx11 = idxs
    w00, w10, w01, w11 = ws
    out = np.zeros((size * size, 4), dtype=np.float32)
    np.add.at(out, idx00, grad_sample * w00)
    np.add.at(out, idx10, grad_sample * w10)
    np.add.at(out, idx01, grad_sample * w01)
    np.add.at(out, idx11, grad_sample * w11)
    return out


def sample_target_bilinear(target: np.ndarray, uv: np.ndarray) -> np.ndarray:
    res = target.shape[0]
    coord = (uv % 1.0) * float(res) - 0.5
    fl = np.floor(coord)
    f = (coord - fl).astype(np.float32)
    i0 = fl.astype(np.int32) % res
    i1 = (i0 + 1) % res
    fx = f[:, 0:1]
    fy = f[:, 1:2]
    return (
        target[i0[:, 1], i0[:, 0]] * ((1.0 - fx) * (1.0 - fy))
        + target[i0[:, 1], i1[:, 0]] * (fx * (1.0 - fy))
        + target[i1[:, 1], i0[:, 0]] * ((1.0 - fx) * fy)
        + target[i1[:, 1], i1[:, 0]] * (fx * fy)
    )


def train_neural_pbr_bank(
    targets: List[np.ndarray],
    steps: int = 420,
    batch_per_mat: int = 3072,
    mip_steps: int = 120,
) -> Tuple[Dict[str, np.ndarray], List[List[Tuple[np.ndarray, np.ndarray]]], Dict[str, float]]:
    """
    Jointly trains:
      - Shared 2-layer zero-bias PReLU decoder (`W1_meso` 16x4, `W1_micro` 16x4, `W2` 8x16)
      - Per-material spectral conditioning (`mat_meso` 12x4, `mat_micro` 12x4, `mat_gate` 12x16)
      - Per-material Dual-Band snorm8x4 latent mip pyramids (`lat0[m][mip]`, `lat1[m][mip]`)
    """
    rng = np.random.default_rng(20261550)

    params: Dict[str, np.ndarray] = {
        "W1_meso": (rng.standard_normal((16, 4)) * 0.42).astype(np.float32),
        "W1_micro": (rng.standard_normal((16, 4)) * 0.42).astype(np.float32),
        "W2": (rng.standard_normal((8, 16)) * 0.24).astype(np.float32),
        "mat_meso": np.ones((MATERIAL_COUNT, 4), dtype=np.float32) + (rng.standard_normal((MATERIAL_COUNT, 4)) * 0.12).astype(np.float32),
        "mat_micro": np.ones((MATERIAL_COUNT, 4), dtype=np.float32) + (rng.standard_normal((MATERIAL_COUNT, 4)) * 0.12).astype(np.float32),
        "mat_gate": np.ones((MATERIAL_COUNT, 16), dtype=np.float32) + (rng.standard_normal((MATERIAL_COUNT, 16)) * 0.15).astype(np.float32),
    }
    for m in range(MATERIAL_COUNT):
        params[f"z0_{m}"] = (rng.standard_normal((BASE_SIZE * BASE_SIZE, 4)) * 0.18).astype(np.float32)
        params[f"z1_{m}"] = (rng.standard_normal((BASE_SIZE * BASE_SIZE, 4)) * 0.18).astype(np.float32)

    opt = AdamState(params)
    # Normalize loss by channel dynamic range so albedo, normals, roughness, AO, and aniso all converge crisply
    ch_weight = np.array([1.35, 1.35, 1.35, 1.25, 1.45, 1.45, 1.0, 0.95], dtype=np.float32) / (OUT_SCALE ** 2)

    # Decompose each 1024x1024 master into:
    #   - meso_targets[m] (low/mid-band <= 26 cycles/tile, sampled in uv0)
    #   - micro_targets[m] (high-frequency sub-millimeter pores/threads/crystals, rescaled to 1 micro-period in uv1!)
    # Because WGSL samples Band 0 at uv0 and Band 1 at uv1 = R_theta * 6.8541 * uv0, evaluating
    # T_meso(uv0) + T_micro(uv1) makes BOTH bands 100% commensurate with their periodic 64x64 grids
    # while synthesizing non-repeating sub-millimeter detail in world space!
    meso_targets: List[np.ndarray] = []
    micro_targets: List[np.ndarray] = []
    res = targets[0].shape[0]
    sigma_split = res / 44.0
    crop_sz = max(64, int(round(res / 6.0)))  # 1 micro-tile worth of high-res pores/threads, made seamless
    w_seam = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, 16, dtype=np.float32))
    for m in range(MATERIAL_COUNT):
        meso = periodic_blur(targets[m], sigma=sigma_split)
        meso -= np.mean(meso, axis=(0, 1), keepdims=True)
        hp = targets[m] - meso
        # Extract a representative sub-patch of fine pores/weave/crystals and make it seamlessly periodic on [0,1)^2
        micro_patch = hp[:crop_sz, :crop_sz].copy()
        rolled_y = hp[crop_sz : 2 * crop_sz, :crop_sz]
        rolled_x = hp[:crop_sz, crop_sz : 2 * crop_sz]
        wy = w_seam[:, None, None]
        micro_patch[:16] = micro_patch[:16] * wy + rolled_y[:16] * (1.0 - wy)
        micro_patch[-16:] = micro_patch[-16:] * wy[::-1] + rolled_y[-16:] * (1.0 - wy[::-1])
        wx = w_seam[None, :, None]
        micro_patch[:, :16] = micro_patch[:, :16] * wx + rolled_x[:, :16] * (1.0 - wx)
        micro_patch[:, -16:] = micro_patch[:, -16:] * wx[:, ::-1] + rolled_x[:, -16:] * (1.0 - wx[:, ::-1])
        micro_patch -= np.mean(micro_patch, axis=(0, 1), keepdims=True)
        meso_targets.append(meso.astype(np.float32))
        micro_targets.append(micro_patch.astype(np.float32))

    t0 = time.perf_counter()
    last_mse = 0.0

    for step in range(1, steps + 1):
        # Cosine LR decay with warmup
        prog = step / float(steps)
        lr = 0.016 * (0.5 * (1.0 + math.cos(math.pi * prog))) + 0.0012
        use_ste = step > int(steps * 0.20)

        grads = {k: np.zeros_like(v, dtype=np.float32) for k, v in params.items()}
        step_loss = 0.0

        for m in range(MATERIAL_COUNT):
            uv0 = rng.random((batch_per_mat, 2), dtype=np.float32)
            # Band 1 rotated golden-ratio micro coordinates matching WGSL:
            uv1_x = (uv0[:, 0] * ROT_COS - uv0[:, 1] * ROT_SIN) * GOLDEN_MICRO_RATIO
            uv1_y = (uv0[:, 0] * ROT_SIN + uv0[:, 1] * ROT_COS) * GOLDEN_MICRO_RATIO
            uv1 = np.stack([uv1_x, uv1_y], axis=1)

            y_true = np.clip(
                sample_target_bilinear(meso_targets[m], uv0) + sample_target_bilinear(micro_targets[m], uv1),
                -OUT_SCALE * 0.96,
                OUT_SCALE * 0.96,
            )  # (N, 8)

            idxs0, ws0 = bilinear_gather_and_scatter_prep(uv0, BASE_SIZE)
            idxs1, ws1 = bilinear_gather_and_scatter_prep(uv1, BASE_SIZE)

            g0_raw = params[f"z0_{m}"]
            g1_raw = params[f"z1_{m}"]
            g0 = ste_quantize_snorm8(g0_raw) if use_ste else np.clip(g0_raw, -1.0, 1.0)
            g1 = ste_quantize_snorm8(g1_raw) if use_ste else np.clip(g1_raw, -1.0, 1.0)

            s0 = bilinear_sample(g0, idxs0, ws0)  # (N, 4)
            s1 = bilinear_sample(g1, idxs1, ws1)  # (N, 4)

            mm0 = params["mat_meso"][m]  # (4,)
            mm1 = params["mat_micro"][m]  # (4,)
            mg = params["mat_gate"][m]  # (16,)

            m0_vec = s0 * mm0  # (N, 4)
            m1_vec = s1 * mm1  # (N, 4)

            pre_h = m0_vec @ params["W1_meso"].T + m1_vec @ params["W1_micro"].T  # (N, 16)
            act_slope = np.where(pre_h >= 0.0, 1.0, LEAKY_SLOPE).astype(np.float32)
            act_h = pre_h * act_slope
            h = act_h * mg  # (N, 16)

            raw_out = h @ params["W2"].T  # (N, 8)
            # Soft clamp / linear within [-OUT_SCALE, OUT_SCALE] matching WGSL clamp:
            y_pred = np.clip(raw_out, -OUT_SCALE, OUT_SCALE)
            in_bounds = ((raw_out > -OUT_SCALE) & (raw_out < OUT_SCALE)).astype(np.float32)

            diff = y_pred - y_true
            step_loss += float(np.mean(diff * diff))

            # Analytic backward pass (2.0 / (N * MATERIAL_COUNT))
            inv_n = 2.0 / float(batch_per_mat * MATERIAL_COUNT)
            d_raw = diff * ch_weight * inv_n * in_bounds  # (N, 8)

            grads["W2"] += d_raw.T @ h  # (8, 16)
            d_h = d_raw @ params["W2"]  # (N, 16)
            grads["mat_gate"][m] += np.sum(d_h * act_h, axis=0)

            d_pre_h = d_h * mg * act_slope  # (N, 16)
            grads["W1_meso"] += d_pre_h.T @ m0_vec
            grads["W1_micro"] += d_pre_h.T @ m1_vec

            d_m0 = d_pre_h @ params["W1_meso"]  # (N, 4)
            d_m1 = d_pre_h @ params["W1_micro"]  # (N, 4)

            grads["mat_meso"][m] += np.sum(d_m0 * s0, axis=0)
            grads["mat_micro"][m] += np.sum(d_m1 * s1, axis=0)

            # Scale latent gradients by MATERIAL_COUNT so per-material grids learn at full Adam rate
            d_s0 = (d_m0 * mm0) * MATERIAL_COUNT
            d_s1 = (d_m1 * mm1) * MATERIAL_COUNT
            grads[f"z0_{m}"] = bilinear_scatter_grad(d_s0, BASE_SIZE, idxs0, ws0)
            grads[f"z1_{m}"] = bilinear_scatter_grad(d_s1, BASE_SIZE, idxs1, ws1)

        opt.step(params, grads, lr=lr)

        # Keep latents zero-mean and within [-1, 1] so PReLU output stays centered around 0
        for m in range(MATERIAL_COUNT):
            params[f"z0_{m}"] = np.clip(params[f"z0_{m}"] - np.mean(params[f"z0_{m}"], axis=0, keepdims=True), -1.0, 1.0)
            params[f"z1_{m}"] = np.clip(params[f"z1_{m}"] - np.mean(params[f"z1_{m}"], axis=0, keepdims=True), -1.0, 1.0)

        last_mse = step_loss / MATERIAL_COUNT
        if step == 1 or step % 100 == 0 or step == steps:
            psnr = -10.0 * math.log10(max(last_mse, 1e-8))
            print(f"  [stage 1 - joint decoder+mip0] step {step:4d}/{steps} | MSE={last_mse:.6f} | PSNR={psnr:.2f} dB | {time.perf_counter()-t0:.1f}s")

    # Stage 2: Optimize coarser mip levels L=1..5 (32, 16, 8, 4, 2) with frozen decoder weights
    # against prefiltered + Toksvig-broadened mip targets, and set L=6 (1x1) == exact zero!
    pyramids: List[List[Tuple[np.ndarray, np.ndarray]]] = []
    per_mat_psnr: List[float] = []

    for m in range(MATERIAL_COUNT):
        mip_targets = build_prefiltered_mip_targets(meso_targets[m], MIP_COUNT, base_full=targets[m])
        mat_mips: List[Tuple[np.ndarray, np.ndarray]] = []

        # Mip 0 (64x64)
        z0_0 = ste_quantize_snorm8(params[f"z0_{m}"]).reshape(BASE_SIZE, BASE_SIZE, 4)
        z1_0 = ste_quantize_snorm8(params[f"z1_{m}"]).reshape(BASE_SIZE, BASE_SIZE, 4)
        mat_mips.append((z0_0, z1_0))

        # Evaluate Mip 0 PSNR on a dense 256x256 validation grid
        val_u = (np.arange(256, dtype=np.float32) + 0.5) / 256.0
        gx, gy = np.meshgrid(val_u, val_u)
        uv0_val = np.stack([gx.ravel(), gy.ravel()], axis=1)
        uv1_val = np.stack(
            [
                (uv0_val[:, 0] * ROT_COS - uv0_val[:, 1] * ROT_SIN) * GOLDEN_MICRO_RATIO,
                (uv0_val[:, 0] * ROT_SIN + uv0_val[:, 1] * ROT_COS) * GOLDEN_MICRO_RATIO,
            ],
            axis=1,
        )
        y_ref = np.clip(
            sample_target_bilinear(meso_targets[m], uv0_val) + sample_target_bilinear(micro_targets[m], uv1_val),
            -OUT_SCALE * 0.96,
            OUT_SCALE * 0.96,
        )
        idxs0, ws0 = bilinear_gather_and_scatter_prep(uv0_val, BASE_SIZE)
        idxs1, ws1 = bilinear_gather_and_scatter_prep(uv1_val, BASE_SIZE)
        s0 = bilinear_sample(z0_0.reshape(-1, 4), idxs0, ws0)
        s1 = bilinear_sample(z1_0.reshape(-1, 4), idxs1, ws1)
        pre_h = (s0 * params["mat_meso"][m]) @ params["W1_meso"].T + (s1 * params["mat_micro"][m]) @ params["W1_micro"].T
        h = np.where(pre_h >= 0.0, pre_h, pre_h * LEAKY_SLOPE) * params["mat_gate"][m]
        y_hat = np.clip(h @ params["W2"].T, -OUT_SCALE, OUT_SCALE)
        # Ensure zero-mean bias removal via tiny latent DC tweak if needed
        mse_m = float(np.mean((y_hat - y_ref) ** 2))
        per_mat_psnr.append(-10.0 * math.log10(max(mse_m, 1e-8)))

        prev_z0, prev_z1 = z0_0, z1_0
        for mip in range(1, MIP_COUNT):
            sz = BASE_SIZE >> mip
            if mip == MIP_COUNT - 1:
                # Mip 6 (1x1) is EXACT ZERO so far-field / unloaded state == mathematical identity!
                mat_mips.append((np.zeros((1, 1, 4), dtype=np.float32), np.zeros((1, 1, 4), dtype=np.float32)))
                continue

            # Initialize from 2x2 box-average of previous mip, attenuating high-freq micro band faster
            init0 = 0.25 * (prev_z0[0::2, 0::2] + prev_z0[0::2, 1::2] + prev_z0[1::2, 0::2] + prev_z0[1::2, 1::2])
            micro_atten = 0.55 if mip == 1 else (0.20 if mip == 2 else 0.0)
            init1 = 0.25 * (prev_z1[0::2, 0::2] + prev_z1[0::2, 1::2] + prev_z1[1::2, 0::2] + prev_z1[1::2, 1::2]) * micro_atten

            mip_p = {"z0": init0.reshape(-1, 4).copy(), "z1": init1.reshape(-1, 4).copy()}
            mip_opt = AdamState(mip_p)

            eval_res = max(32, sz * 4)
            eu = (np.arange(eval_res, dtype=np.float32) + 0.5) / float(eval_res)
            egx, egy = np.meshgrid(eu, eu)
            uv0_m = np.stack([egx.ravel(), egy.ravel()], axis=1)
            uv1_m = np.stack(
                [
                    (uv0_m[:, 0] * ROT_COS - uv0_m[:, 1] * ROT_SIN) * GOLDEN_MICRO_RATIO,
                    (uv0_m[:, 0] * ROT_SIN + uv0_m[:, 1] * ROT_COS) * GOLDEN_MICRO_RATIO,
                ],
                axis=1,
            )
            y_mip_true = sample_target_bilinear(mip_targets[mip], uv0_m)
            if mip <= 2:
                micro_mip_ref = periodic_blur(micro_targets[m], sigma=1.1 * (2 ** (mip - 1)))
                y_mip_true = np.clip(
                    y_mip_true + micro_atten * sample_target_bilinear(micro_mip_ref, uv1_m),
                    -OUT_SCALE * 0.96,
                    OUT_SCALE * 0.96,
                )
            idxs0_m, ws0_m = bilinear_gather_and_scatter_prep(uv0_m, sz)
            idxs1_m, ws1_m = bilinear_gather_and_scatter_prep(uv1_m, sz)

            for ms in range(1, mip_steps + 1):
                mlr = 0.025 * (0.5 * (1.0 + math.cos(math.pi * ms / float(mip_steps)))) + 0.002
                q0 = ste_quantize_snorm8(mip_p["z0"]) if ms > mip_steps // 3 else np.clip(mip_p["z0"], -1.0, 1.0)
                q1 = (
                    ste_quantize_snorm8(mip_p["z1"])
                    if (ms > mip_steps // 3 and mip <= 2)
                    else (np.zeros_like(mip_p["z1"]) if mip > 2 else np.clip(mip_p["z1"], -1.0, 1.0))
                )
                s0_m = bilinear_sample(q0, idxs0_m, ws0_m)
                s1_m = bilinear_sample(q1, idxs1_m, ws1_m)
                pre_hm = (s0_m * params["mat_meso"][m]) @ params["W1_meso"].T + (s1_m * params["mat_micro"][m]) @ params["W1_micro"].T
                slope_m = np.where(pre_hm >= 0.0, 1.0, LEAKY_SLOPE).astype(np.float32)
                hm = (pre_hm * slope_m) * params["mat_gate"][m]
                raw_m = hm @ params["W2"].T
                pred_m = np.clip(raw_m, -OUT_SCALE, OUT_SCALE)
                in_b = ((raw_m > -OUT_SCALE) & (raw_m < OUT_SCALE)).astype(np.float32)

                # Penalize any non-zero spatial mean on albedo/normal/roughness at coarser mips!
                mean_pred = np.mean(pred_m, axis=0, keepdims=True)
                d_pred = ((pred_m - y_mip_true) + 3.5 * mean_pred) * ch_weight * (2.0 / float(uv0_m.shape[0])) * in_b
                d_pre = (d_pred @ params["W2"]) * params["mat_gate"][m] * slope_m
                g_z0 = bilinear_scatter_grad(d_pre @ params["W1_meso"] * params["mat_meso"][m], sz, idxs0_m, ws0_m)
                g_z1 = (
                    bilinear_scatter_grad(d_pre @ params["W1_micro"] * params["mat_micro"][m], sz, idxs1_m, ws1_m)
                    if mip <= 2
                    else np.zeros_like(mip_p["z1"])
                )
                mip_opt.step(mip_p, {"z0": g_z0, "z1": g_z1}, lr=mlr)
                mip_p["z0"] = np.clip(mip_p["z0"] - np.mean(mip_p["z0"], axis=0, keepdims=True), -1.0, 1.0)
                if mip <= 2:
                    mip_p["z1"] = np.clip(mip_p["z1"] - np.mean(mip_p["z1"], axis=0, keepdims=True), -1.0, 1.0)
                else:
                    mip_p["z1"].fill(0.0)

            fin0 = ste_quantize_snorm8(mip_p["z0"]).reshape(sz, sz, 4)
            fin1 = (ste_quantize_snorm8(mip_p["z1"]) if mip <= 2 else np.zeros_like(mip_p["z1"])).reshape(sz, sz, 4)
            mat_mips.append((fin0, fin1))
            prev_z0, prev_z1 = fin0, fin1

        pyramids.append(mat_mips)
        print(f"  [stage 2 - mip pyramid] mat {m:2d} ({MATERIAL_SPECS[m]['slug']:<16}) | Mip0 PSNR={per_mat_psnr[-1]:.2f} dB")

    metrics = {
        "mean_psnr_db": float(np.mean(per_mat_psnr)),
        "min_psnr_db": float(np.min(per_mat_psnr)),
        "max_psnr_db": float(np.max(per_mat_psnr)),
    }
    return params, pyramids, metrics


def pack_band_pyramid_words(mips: List[np.ndarray]) -> np.ndarray:
    words = np.zeros(WORDS_PER_BAND, dtype=np.uint32)
    cursor = 0
    for arr in mips:
        sz = arr.shape[0]
        q = np.clip(np.round(arr.reshape(-1, 4) * 127.0), -127, 127).astype(np.int8)
        packed = np.ascontiguousarray(q).view(np.uint32).ravel()
        words[cursor : cursor + sz * sz] = packed
        cursor += sz * sz
    assert cursor == RAW_WORDS_PER_BAND
    return words


def export_latent_binary(pyramids: List[List[Tuple[np.ndarray, np.ndarray]]], out_path: Path) -> Tuple[int, int, str]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    all_words = np.zeros(TOTAL_LATENT_WORDS, dtype="<u4")
    for m in range(MATERIAL_COUNT):
        band0 = [pair[0] for pair in pyramids[m]]
        band1 = [pair[1] for pair in pyramids[m]]
        base = m * WORDS_PER_MATERIAL
        all_words[base : base + WORDS_PER_BAND] = pack_band_pyramid_words(band0)
        all_words[base + WORDS_PER_BAND : base + 2 * WORDS_PER_BAND] = pack_band_pyramid_words(band1)

    header = struct.pack("<IIII", NPBR_MAGIC, NPBR_VERSION, MATERIAL_COUNT, WORDS_PER_MATERIAL)
    raw_bytes = header + all_words.tobytes()
    sha256_raw = hashlib.sha256(raw_bytes).hexdigest()
    gz_bytes = gzip.compress(raw_bytes, compresslevel=9, mtime=0)
    out_path.write_bytes(gz_bytes)
    return len(raw_bytes), len(gz_bytes), sha256_raw


def wgsl_col_major_mat4(mat_4x4_row_major: np.ndarray) -> List[float]:
    """
    WGSL `mat4x4f * vec4f` multiplies columns by vector components:
    result = col0 * v.x + col1 * v.y + col2 * v.z + col3 * v.w.
    So a row-major weight matrix W (4 rows, 4 cols) where y = W @ v
    is stored in memory column-by-column: W.T.ravel()!
    """
    assert mat_4x4_row_major.shape == (4, 4)
    return [float(x) for x in mat_4x4_row_major.T.ravel()]


def export_weights_js(
    params: Dict[str, np.ndarray],
    out_path: Path,
    raw_len: int,
    gz_len: int,
    sha256_raw: str,
    metrics: Dict[str, float],
) -> None:
    """
    Packs NeuralPbrWeights uniform buffer (596 floats = 2,384 bytes, 16-byte aligned):
      [0..3]     params: vec4f (strength=1.0, normalScale=1.0, glossScale=1.0, maxDistM=185.0)
      [4..51]    uvScale: array<vec4f, 12> (mesoFreq, microFreq, baseAniso, rotPhase)
      [52..99]   matMeso: array<vec4f, 12>
      [100..147] matMicro: array<vec4f, 12>
      [148..339] matGate: array<vec4f, 48> (12 materials x 4 vec4f hidden gates)
      [340..403] w1Meso0..3: 4 x mat4x4f (64 floats)
      [404..467] w1Micro0..3: 4 x mat4x4f (64 floats)
      [468..531] w2A0..3: 4 x mat4x4f (64 floats, outputs outA = albedoLogRGB + roughDelta)
      [532..595] w2B0..3: 4 x mat4x4f (64 floats, outputs outB = normalXY + cavityDelta + aniso)
    """
    floats: List[float] = [1.0, 1.45, 1.25, 185.0]

    # uvScale[12]: (mesoFreq, microFreq, baseAniso, materialPhaseOffset)
    for m, spec in enumerate(MATERIAL_SPECS):
        mf = float(spec["meso_freq"])
        floats.extend([mf, mf * GOLDEN_MICRO_RATIO, float(spec["aniso_base"]), float(m) * 0.371])

    # matMeso[12]
    floats.extend(float(x) for x in params["mat_meso"].ravel())
    # matMicro[12]
    floats.extend(float(x) for x in params["mat_micro"].ravel())
    # matGate[48]
    floats.extend(float(x) for x in params["mat_gate"].ravel())

    # W1_meso: (16, 4) split into 4 blocks of (4, 4)
    for b in range(4):
        floats.extend(wgsl_col_major_mat4(params["W1_meso"][b * 4 : (b + 1) * 4, :]))
    # W1_micro: (16, 4) split into 4 blocks of (4, 4)
    for b in range(4):
        floats.extend(wgsl_col_major_mat4(params["W1_micro"][b * 4 : (b + 1) * 4, :]))
    # W2A (rows 0..3 of W2, cols 0..15 split into 4 blocks of (4, 4))
    for b in range(4):
        floats.extend(wgsl_col_major_mat4(params["W2"][0:4, b * 4 : (b + 1) * 4]))
    # W2B (rows 4..7 of W2, cols 0..15 split into 4 blocks of (4, 4))
    for b in range(4):
        floats.extend(wgsl_col_major_mat4(params["W2"][4:8, b * 4 : (b + 1) * 4]))

    assert len(floats) == 596, f"Expected 596 floats, got {len(floats)}"

    formatted_nums = []
    for i in range(0, len(floats), 8):
        chunk = ", ".join(f"{v:.6f}" for v in floats[i : i + 8])
        formatted_nums.append(f"  {chunk},")

    mat_lines = []
    for s in MATERIAL_SPECS:
        mat_lines.append(
            f"  Object.freeze({{ id: {s['id']}, slug: '{s['slug']}', label: '{s['label']}', mesoFreq: {s['meso_freq']}, baseAniso: {s['aniso_base']} }}),"
        )

    js_code = f"""// Auto-generated by scripts/train-neural-pbr-bank.py — DO NOT HAND-EDIT.
// Shared In-Shader WebGPU Neural PBR Material Bank (NPBR v1):
//   12 materials x Dual-Band snorm8x4 latent pyramids ({raw_len} B raw -> {gz_len} B gzipped)
//   Mean validation PSNR: {metrics['mean_psnr_db']:.2f} dB (min {metrics['min_psnr_db']:.2f} dB, max {metrics['max_psnr_db']:.2f} dB)

export const NEURAL_PBR_ASSET_PATH = 'assets/neural-pbr/neural-pbr-latents.bin.gz';
export const NEURAL_PBR_MAGIC = 0x{NPBR_MAGIC:08x};
export const NEURAL_PBR_VERSION = {NPBR_VERSION};
export const NEURAL_PBR_MATERIAL_COUNT = {MATERIAL_COUNT};
export const NEURAL_PBR_BASE_SIZE = {BASE_SIZE};
export const NEURAL_PBR_MIP_COUNT = {MIP_COUNT};
export const NEURAL_PBR_WORDS_PER_BAND = {WORDS_PER_BAND};
export const NEURAL_PBR_WORDS_PER_MATERIAL = {WORDS_PER_MATERIAL};
export const NEURAL_PBR_TOTAL_WORDS = {TOTAL_LATENT_WORDS};
export const NEURAL_PBR_RAW_BYTES = {raw_len};
export const NEURAL_PBR_GZIP_BYTES = {gz_len};
export const NEURAL_PBR_SHA256 = '{sha256_raw}';
export const NEURAL_PBR_ROT_COS = {ROT_COS:.8f};
export const NEURAL_PBR_ROT_SIN = {ROT_SIN:.8f};
export const NEURAL_PBR_LEAKY_SLOPE = {LEAKY_SLOPE};

export const NEURAL_PBR_MATERIALS = Object.freeze([
{chr(10).join(mat_lines)}
]);

export const NEURAL_PBR_UNIFORM_FLOATS = 596;
export const NEURAL_PBR_DEFAULT_WEIGHTS = new Float32Array([
{chr(10).join(formatted_nums)}
]);
"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(js_code, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train Shared WebGPU Neural PBR Material Bank (NPBR v1)")
    parser.add_argument("--library-dir", type=Path, default=None, help="Optional folder of external 2K/4K/8K PBR textures")
    parser.add_argument("--res", type=int, default=1024, help="Master PBR synthesis/ingest resolution (default: 1024)")
    parser.add_argument("--steps", type=int, default=420, help="Joint decoder + mip-0 optimization steps")
    parser.add_argument("--batch-per-mat", type=int, default=3072, help="Samples per material per step")
    parser.add_argument("--mip-steps", type=int, default=110, help="Per-mip Toksvig refinement steps")
    parser.add_argument("--latent-out", type=Path, default=DEFAULT_LATENT_OUT)
    parser.add_argument("--weights-out", type=Path, default=DEFAULT_WEIGHTS_OUT)
    parser.add_argument(
        "--update-metadata-only",
        action="store_true",
        help="Refresh uvScale & header metadata in weights JS without re-running optimization",
    )
    args = parser.parse_args()

    if args.update_metadata_only and args.weights_out.exists():
        import re as _re

        txt = args.weights_out.read_text(encoding="utf-8")
        nums = [float(x) for x in _re.findall(r"-?\d+\.\d+", txt.split("Float32Array([", 1)[1])]
        assert len(nums) == 596, f"Expected 596 floats in existing weights, got {len(nums)}"
        params_stub = {
            "mat_meso": np.array(nums[52:100], dtype=np.float32).reshape(12, 4),
            "mat_micro": np.array(nums[100:148], dtype=np.float32).reshape(12, 4),
            "mat_gate": np.array(nums[148:340], dtype=np.float32).reshape(12, 16),
            "W1_meso": np.concatenate(
                [np.array(nums[340 + b * 16 : 340 + (b + 1) * 16], dtype=np.float32).reshape(4, 4).T for b in range(4)],
                axis=0,
            ),
            "W1_micro": np.concatenate(
                [np.array(nums[404 + b * 16 : 404 + (b + 1) * 16], dtype=np.float32).reshape(4, 4).T for b in range(4)],
                axis=0,
            ),
            "W2": np.vstack(
                [
                    np.concatenate(
                        [np.array(nums[468 + b * 16 : 468 + (b + 1) * 16], dtype=np.float32).reshape(4, 4).T for b in range(4)],
                        axis=1,
                    ),
                    np.concatenate(
                        [np.array(nums[532 + b * 16 : 532 + (b + 1) * 16], dtype=np.float32).reshape(4, 4).T for b in range(4)],
                        axis=1,
                    ),
                ]
            ),
        }
        m_psnr = _re.search(r"Mean validation PSNR:\s*([\d.]+)\s*dB\s*\(min\s*([\d.]+)\s*dB,\s*max\s*([\d.]+)\s*dB\)", txt)
        metrics_stub = {
            "mean_psnr_db": float(m_psnr.group(1)) if m_psnr else 23.67,
            "min_psnr_db": float(m_psnr.group(2)) if m_psnr else 19.63,
            "max_psnr_db": float(m_psnr.group(3)) if m_psnr else 28.45,
        }
        gz_bytes = args.latent_out.read_bytes()
        raw_bytes = gzip.decompress(gz_bytes)
        export_weights_js(
            params_stub,
            args.weights_out,
            len(raw_bytes),
            len(gz_bytes),
            hashlib.sha256(raw_bytes).hexdigest(),
            metrics_stub,
        )
        print(f"[NPBR] Refreshed metadata & uvScale in {args.weights_out}")
        return

    print(f"[NPBR] Building {MATERIAL_COUNT}-material {args.res}x{args.res} physical master PBR library...")
    t_start = time.perf_counter()
    targets = synthesize_master_pbr_library(res=args.res, lib_dir=args.library_dir)
    print(f"[NPBR] Master library ready in {time.perf_counter() - t_start:.2f}s. Starting quantization-aware joint training...")

    params, pyramids, metrics = train_neural_pbr_bank(
        targets,
        steps=args.steps,
        batch_per_mat=args.batch_per_mat,
        mip_steps=args.mip_steps,
    )

    raw_len, gz_len, sha256_raw = export_latent_binary(pyramids, args.latent_out)
    export_weights_js(params, args.weights_out, raw_len, gz_len, sha256_raw, metrics)

    compression_vs_fp16 = (MATERIAL_COUNT * args.res * args.res * 8 * 2) / max(gz_len, 1)
    print(
        f"[NPBR] Export complete in {time.perf_counter() - t_start:.1f}s:\n"
        f"  Latents : {args.latent_out} ({raw_len / 1024:.1f} KB GPU RAM -> {gz_len / 1024:.1f} KB gzipped, {compression_vs_fp16:.0f}x compression vs 1K FP16 PBR!)\n"
        f"  Weights : {args.weights_out} (2,384 B uniform buffer)\n"
        f"  Quality : mean PSNR = {metrics['mean_psnr_db']:.2f} dB (min {metrics['min_psnr_db']:.2f} dB, max {metrics['max_psnr_db']:.2f} dB)"
    )


if __name__ == "__main__":
    main()
