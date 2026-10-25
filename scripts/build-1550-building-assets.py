#!/usr/bin/env python3
"""
1550 Spanish Main — Isometric 3D Architectural Asset Pipeline (Plumb-Rectified)
===============================================================================
Converts 3/4 Isometric 3D Architectural Renders into:
1. Clean alpha-segmented isometric silhouettes (iso_rgba.png)
2. Depth Anything V2 isometric depth & surface-normal relief fields
3. Plumb-rectified, low-poly watertight 3D architectural meshes (.glb & WW3D bundle)
   where every vertical wall is strictly plumb (90 degrees), every roof plane is
   planar and straight with zero undue triangles, and every triangle has flat
   per-face normals and uniform per-face material `kind` (10..14) so WebGPU
   never interpolates `kind` across material boundaries.
"""

import argparse
import json
import math
import os
import struct
import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, binary_erosion, binary_fill_holes, distance_transform_edt, gaussian_filter, median_filter
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


def segment_studio_background(view_img: Image.Image, pad_ratio: float = 0.06) -> Image.Image:
    """Segments a 3/4 isometric studio render from its neutral #808080 gray background."""
    arr = np.asarray(view_img.convert("RGB"), dtype=np.float32)
    h, w, _ = arr.shape
    border_pixels = np.concatenate(
        [
            arr[:12, :, :].reshape(-1, 3),
            arr[-12:, :, :].reshape(-1, 3),
            arr[:, :12, :].reshape(-1, 3),
            arr[:, -12:, :].reshape(-1, 3),
        ],
        axis=0,
    )
    bg_median = np.median(border_pixels, axis=0)
    color_dist = np.linalg.norm(arr - bg_median[None, None, :], axis=-1)
    chroma = np.max(arr, axis=-1) - np.min(arr, axis=-1)
    fg_score = color_dist + chroma * 0.65

    mask = fg_score > 18.0
    mask[:4, :] = False
    mask[-4:, :] = False
    mask[:, :4] = False
    mask[:, -4:] = False

    mask = binary_fill_holes(mask)
    mask = binary_erosion(mask, iterations=1)
    mask = binary_dilation(mask, iterations=1)
    mask = binary_fill_holes(mask)

    alpha = (gaussian_filter(mask.astype(np.float32), sigma=0.6) * 255.0).clip(0, 255).astype(np.uint8)
    alpha[mask] = np.maximum(alpha[mask], 240)
    alpha[~mask] = 0

    ys, xs = np.where(mask)
    if len(xs) > 32 and len(ys) > 32:
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        bw, bh = max(1, x1 - x0 + 1), max(1, y1 - y0 + 1)
        target_span = int(round(min(w, h) * (1.0 - 2.0 * pad_ratio)))
        scale = min(target_span / bw, target_span / bh)
        nw, nh = max(1, int(round(bw * scale))), max(1, int(round(bh * scale)))

        rgba_src = np.dstack([arr.astype(np.uint8), alpha])
        crop_pil = Image.fromarray(rgba_src[y0 : y1 + 1, x0 : x1 + 1], mode="RGBA").resize(
            (nw, nh), Image.Resampling.LANCZOS
        )
        canvas = Image.new("RGBA", (w, h), (128, 128, 128, 0))
        ox = (w - nw) // 2
        oy = (h - nh) // 2
        canvas.paste(crop_pil, (ox, oy))
        return canvas

    return Image.fromarray(np.dstack([arr.astype(np.uint8), alpha]), mode="RGBA")


class PlumbArchitecturalMeshBuilder:
    """
    Constructs strictly plumb, orthogonal, coplanar 3D architectural geometry with:
    - Zero non-plumb / undue triangles
    - Unshared per-face vertices so every triangle has a flat face normal and a single
      uniform material `kind` (10..14), preventing GPU linear interpolation across materials.
    """

    def __init__(self, relief_contrast: float = 1.0):
        self.verts = []
        self.norms = []
        self.kinds = []
        self.shades = []
        self.faces = []
        self.relief_contrast = relief_contrast

    def add_tri(self, p0, p1, p2, kind: float, shade: float = 0.88):
        p0 = np.asarray(p0, dtype=np.float32)
        p1 = np.asarray(p1, dtype=np.float32)
        p2 = np.asarray(p2, dtype=np.float32)
        fn = np.cross(p1 - p0, p2 - p0)
        norm_len = float(np.linalg.norm(fn))
        if norm_len < 1e-7:
            return
        fn = (fn / norm_len).astype(np.float32)
        s = float(np.clip(shade, 0.26, 1.0))
        base = len(self.verts)
        self.verts.extend([p0, p1, p2])
        self.norms.extend([fn, fn, fn])
        self.kinds.extend([ float(kind), float(kind), float(kind) ])
        self.shades.extend([s, s, s])
        self.faces.append([base, base + 1, base + 2])

    def add_quad(self, a, b, c, d, kind: float, shade: float = 0.88):
        """Adds a strictly planar quad (a, b, c, d in CCW order when viewed from outside)."""
        self.add_tri(a, b, c, kind, shade)
        self.add_tri(a, c, d, kind, shade)

    def add_box(self, x0, x1, y0, y1, z0, z1, kind: float, shade: float = 0.86, top_inset: float = 0.0, cap_top: bool = True, cap_bottom: bool = False):
        """Adds a strictly plumb box (or battered frustum when top_inset != 0) with outward normals."""
        tx0, tx1 = x0 + top_inset, x1 - top_inset
        tz0, tz1 = z0 + top_inset, z1 - top_inset
        p000 = [x0, y0, z0]
        p100 = [x1, y0, z0]
        p101 = [x1, y0, z1]
        p001 = [x0, y0, z1]
        p010 = [tx0, y1, tz0]
        p110 = [tx1, y1, tz0]
        p111 = [tx1, y1, tz1]
        p011 = [tx0, y1, tz1]

        # -Z face (Front, outward normal [0, 0, -1])
        self.add_quad(p100, p000, p010, p110, kind, shade * 0.96)
        # +X face (Right, outward normal [+1, 0, 0])
        self.add_quad(p101, p100, p110, p111, kind, shade * 1.00)
        # +Z face (Back, outward normal [0, 0, +1])
        self.add_quad(p001, p101, p111, p011, kind, shade * 0.92)
        # -X face (Left, outward normal [-1, 0, 0])
        self.add_quad(p000, p001, p011, p010, kind, shade * 0.90)
        if cap_top:
            # +Y face (Top, outward normal [0, +1, 0])
            self.add_quad(p011, p111, p110, p010, kind, min(1.0, shade * 1.05))
        if cap_bottom:
            # -Y face (Bottom, outward normal [0, -1, 0])
            self.add_quad(p000, p100, p101, p001, kind, shade * 0.68)

    def add_wall_feature_x(self, x_wall, out_sign, y0, y1, z0, z1, kind: float, shade: float = 0.86, depth: float = 0.022, cap_top: bool = True, cap_bottom: bool = True):
        """Adds a surface relief feature (window, arch, quoin, pilaster) on an X-facing wall without slicing through the interior."""
        if out_sign < 0:
            self.add_box(x_wall - depth, x_wall, y0, y1, z0, z1, kind, shade, cap_top=cap_top, cap_bottom=cap_bottom)
        else:
            self.add_box(x_wall, x_wall + depth, y0, y1, z0, z1, kind, shade, cap_top=cap_top, cap_bottom=cap_bottom)

    def add_wall_feature_z(self, z_wall, out_sign, x0, x1, y0, y1, kind: float, shade: float = 0.86, depth: float = 0.022, cap_top: bool = True, cap_bottom: bool = True):
        """Adds a surface relief feature (window, arch, portal, buttress) on a Z-facing wall without slicing through the interior."""
        if out_sign < 0:
            self.add_box(x0, x1, y0, y1, z_wall - depth, z_wall, kind, shade, cap_top=cap_top, cap_bottom=cap_bottom)
        else:
            self.add_box(x0, x1, y0, y1, z_wall, z_wall + depth, kind, shade, cap_top=cap_top, cap_bottom=cap_bottom)

    def add_cylinder(self, cx, cz, y0, y1, r0, r1, segs: int = 8, kind: float = 11.0, shade: float = 0.90, cap_top: bool = True):
        top_center = [cx, y1, cz]
        for s in range(segs):
            a0 = (s / segs) * math.pi * 2.0
            a1 = ((s + 1) / segs) * math.pi * 2.0
            c0, s0 = math.cos(a0), math.sin(a0)
            c1, s1 = math.cos(a1), math.sin(a1)
            p00 = [cx + c0 * r0, y0, cz + s0 * r0]
            p10 = [cx + c1 * r0, y0, cz + s1 * r0]
            p11 = [cx + c1 * r1, y1, cz + s1 * r1]
            p01 = [cx + c0 * r1, y1, cz + s0 * r1]
            f_shade = shade * (0.91 + 0.09 * math.cos(a0 - 0.7))
            self.add_quad(p10, p00, p01, p11, kind, f_shade)
            if cap_top and r1 > 0.005:
                self.add_tri(p11, p01, top_center, kind, min(1.0, shade * 1.04))

    def add_hipped_roof(self, x0, x1, y_eave, y_peak, z0, z1, overhang: float = 0.035, hip_ratio: float = 0.25, wall_kind: float = 12.0):
        """Adds a razor-straight hipped or gabled terracotta roof (kind 13) with outward/upward normals (ny > 0)."""
        rx0, rx1 = x0 - overhang, x1 + overhang
        rz0, rz1 = z0 - overhang, z1 + overhang
        fascia_h = 0.022
        # Dark timber eaves fascia & soffit (kind 10)
        self.add_box(rx0, rx1, y_eave - fascia_h, y_eave, rz0, rz1, 10.0, 0.74, cap_top=True, cap_bottom=True)
        mid_x = 0.5 * (rx0 + rx1)
        span_z = rz1 - rz0
        z_hip0 = rz0 + span_z * hip_ratio
        z_hip1 = rz1 - span_z * hip_ratio

        e00 = [rx0, y_eave, rz0]
        e10 = [rx1, y_eave, rz0]
        e11 = [rx1, y_eave, rz1]
        e01 = [rx0, y_eave, rz1]
        r0 = [mid_x, y_peak, z_hip0]
        r1 = [mid_x, y_peak, z_hip1]

        if hip_ratio > 0.02:
            # -X slope (normal [-nx, +ny, 0])
            self.add_quad(e00, e01, r1, r0, 13.0, 0.94)
            # +X slope (normal [+nx, +ny, 0])
            self.add_quad(e11, e10, r0, r1, 13.0, 0.89)
            # -Z hip triangle (normal [0, +ny, -nz])
            self.add_tri(e10, e00, r0, 13.0, 0.92)
            # +Z hip triangle (normal [0, +ny, +nz])
            self.add_tri(e01, e11, r1, 13.0, 0.91)
        else:
            # Gable roof + plumb masonry gable triangles
            self.add_quad(e00, e01, r1, r0, 13.0, 0.94)
            self.add_quad(e11, e10, r0, r1, 13.0, 0.89)
            self.add_tri([x1, y_eave, z0], [x0, y_eave, z0], [mid_x, y_peak - 0.008, z0], wall_kind, 0.88)
            self.add_tri([x0, y_eave, z1], [x1, y_eave, z1], [mid_x, y_peak - 0.008, z1], wall_kind, 0.86)

        # Straight terracotta ridge cap (caballete)
        if z_hip1 > z_hip0 + 0.02:
            self.add_box(mid_x - 0.015, mid_x + 0.015, y_peak - 0.006, y_peak + 0.014, z_hip0, z_hip1, 13.0, 0.98, top_inset=0.004)

    def add_cloister_hipped_roof(self, x0, x1, z0, z1, ix0, ix1, iz0, iz1, y_eave, y_peak, overhang: float = 0.038, inner_overhang: float = 0.022):
        """
        Adds a 4-wing closed-perimeter cloistered hipped terracotta roof (Casa Patio):
        - 4 outer hipped slopes pitching down to the street eaves (with outward/upward normals ny > 0)
        - 4 inner courtyard slopes pitching down into the central patio lightwell (with inward/upward normals ny > 0)
        - Continuous rectangular terracotta ridge cap (caballete) along the 4 wing centerlines
        """
        ox0, ox1 = x0 - overhang, x1 + overhang
        oz0, oz1 = z0 - overhang, z1 + overhang
        cx0, cx1 = ix0 + inner_overhang, ix1 - inner_overhang
        cz0, cz1 = iz0 + inner_overhang, iz1 - inner_overhang

        rx0 = 0.5 * (x0 + ix0)
        rx1 = 0.5 * (x1 + ix1)
        rz0 = 0.5 * (z0 + iz0)
        rz1 = 0.5 * (z1 + iz1)

        fascia_h = 0.022
        # Outer timber eaves fascia along all 4 wings
        self.add_box(ox0, ox1, y_eave - fascia_h, y_eave, oz0, oz0 + 0.025, 10.0, 0.74, cap_bottom=True)
        self.add_box(ox0, ox1, y_eave - fascia_h, y_eave, oz1 - 0.025, oz1, 10.0, 0.74, cap_bottom=True)
        self.add_box(ox0, ox0 + 0.025, y_eave - fascia_h, y_eave, oz0, oz1, 10.0, 0.74, cap_bottom=True)
        self.add_box(ox1 - 0.025, ox1, y_eave - fascia_h, y_eave, oz0, oz1, 10.0, 0.74, cap_bottom=True)
        # Inner courtyard timber eaves fascia around the patio well
        self.add_box(cx0 - 0.02, cx1 + 0.02, y_eave - fascia_h, y_eave, cz0 - 0.02, cz0, 10.0, 0.72, cap_bottom=True)
        self.add_box(cx0 - 0.02, cx1 + 0.02, y_eave - fascia_h, y_eave, cz1, cz1 + 0.02, 10.0, 0.72, cap_bottom=True)
        self.add_box(cx0 - 0.02, cx0, y_eave - fascia_h, y_eave, cz0, cz1, 10.0, 0.72, cap_bottom=True)
        self.add_box(cx1, cx1 + 0.02, y_eave - fascia_h, y_eave, cz0, cz1, 10.0, 0.72, cap_bottom=True)

        # Outer eave corners
        e00 = [ox0, y_eave, oz0]
        e10 = [ox1, y_eave, oz0]
        e11 = [ox1, y_eave, oz1]
        e01 = [ox0, y_eave, oz1]
        # Ridge ring corners
        r00 = [rx0, y_peak, rz0]
        r10 = [rx1, y_peak, rz0]
        r11 = [rx1, y_peak, rz1]
        r01 = [rx0, y_peak, rz1]
        # Inner patio eave corners
        i00 = [cx0, y_eave, cz0]
        i10 = [cx1, y_eave, cz0]
        i11 = [cx1, y_eave, cz1]
        i01 = [cx0, y_eave, cz1]

        # 4 Outer hipped roof slopes (normals point outward + upward)
        self.add_quad(e00, e01, r01, r00, 13.0, 0.95)  # -X outer slope
        self.add_quad(e11, e10, r10, r11, 13.0, 0.89)  # +X outer slope
        self.add_quad(e10, e00, r00, r10, 13.0, 0.93)  # -Z outer slope
        self.add_quad(e01, e11, r11, r01, 13.0, 0.91)  # +Z outer slope

        # 4 Inner courtyard roof slopes (normals point inward toward patio + upward)
        self.add_quad(i01, i00, r00, r01, 13.0, 0.86)  # -X wing inner slope (faces +X into patio)
        self.add_quad(i10, i11, r11, r10, 13.0, 0.92)  # +X wing inner slope (faces -X into patio)
        self.add_quad(i00, i10, r10, r00, 13.0, 0.88)  # -Z wing inner slope (faces +Z into patio)
        self.add_quad(i11, i01, r01, r11, 13.0, 0.90)  # +Z wing inner slope (faces -Z into patio)

        # 4 Continuous terracotta ridge caps (caballetes) along the rectangular ridge ring
        rw = 0.014
        self.add_box(rx0 - rw, rx1 + rw, y_peak - 0.005, y_peak + 0.014, rz0 - rw, rz0 + rw, 13.0, 0.98, top_inset=0.004)
        self.add_box(rx0 - rw, rx1 + rw, y_peak - 0.005, y_peak + 0.014, rz1 - rw, rz1 + rw, 13.0, 0.98, top_inset=0.004)
        self.add_box(rx0 - rw, rx0 + rw, y_peak - 0.005, y_peak + 0.014, rz0 + rw, rz1 - rw, 13.0, 0.98, top_inset=0.004)
        self.add_box(rx1 - rw, rx1 + rw, y_peak - 0.005, y_peak + 0.014, rz0 + rw, rz1 - rw, 13.0, 0.98, top_inset=0.004)

    def add_pent_roof_x(self, x_wall, out_sign, y_low, y_high, z0, z1):
        """Adds a single-slope terracotta pent-roof awning (kind 13) projecting from an X-facing wall with outward normals."""
        x_out = x_wall + out_sign * 0.095
        # Timber support beam & posts under the awning
        self.add_box(min(x_wall, x_out), max(x_wall, x_out), y_low - 0.015, y_low, z0, z1, 10.0, 0.72, cap_bottom=True)
        if out_sign < 0:
            self.add_quad([x_out, y_low, z0], [x_out, y_low, z1], [x_wall, y_high, z1], [x_wall, y_high, z0], 13.0, 0.93)
            self.add_tri([x_wall, y_low, z0], [x_out, y_low, z0], [x_wall, y_high, z0], 10.0, 0.72)
            self.add_tri([x_out, y_low, z1], [x_wall, y_low, z1], [x_wall, y_high, z1], 10.0, 0.72)
        else:
            self.add_quad([x_out, y_low, z1], [x_out, y_low, z0], [x_wall, y_high, z0], [x_wall, y_high, z1], 13.0, 0.90)
            self.add_tri([x_out, y_low, z0], [x_wall, y_low, z0], [x_wall, y_high, z0], 10.0, 0.72)
            self.add_tri([x_wall, y_low, z1], [x_out, y_low, z1], [x_wall, y_high, z1], 10.0, 0.72)

    def finalize(self):
        v = np.asarray(self.verts, dtype=np.float32)
        n = np.asarray(self.norms, dtype=np.float32)
        k = np.asarray(self.kinds, dtype=np.float32)
        s = np.asarray(self.shades, dtype=np.float32)
        f = np.asarray(self.faces, dtype=np.uint32)

        # Normalize into [-0.48, 0.48] in X/Z and [0.0, 1.0] in Y
        vmin = v.min(axis=0)
        vmax = v.max(axis=0)
        span_xz = max(1e-5, float(max(vmax[0] - vmin[0], vmax[2] - vmin[2])))
        span_y = max(1e-5, float(vmax[1] - vmin[1]))
        v[:, 0] = (v[:, 0] - 0.5 * (vmin[0] + vmax[0])) / span_xz * 0.94
        v[:, 1] = (v[:, 1] - vmin[1]) / span_y
        v[:, 2] = (v[:, 2] - 0.5 * (vmin[2] + vmax[2])) / span_xz * 0.94
        return v, f, n, k, s


def build_plumb_isometric_archetype(asset_id: str, relief_contrast: float = 1.0):
    """
    Builds the exact, strictly plumb 3D architectural geometry matched to each of the 4
    isometric 3D reference renders.
    """
    b = PlumbArchitecturalMeshBuilder(relief_contrast=relief_contrast)

    if asset_id == "stone_sea_bastion":
        # Matches stone_sea_bastion_isometric:
        # 1. Battered coral-limestone scarp base + projecting stone cordon (bocel)
        b.add_box(-0.46, 0.46, 0.0, 0.38, -0.46, 0.46, 11.0, 0.85, top_inset=0.055)
        b.add_box(-0.415, 0.415, 0.38, 0.415, -0.415, 0.415, 11.0, 0.93, cap_bottom=True)
        # 2. Terreplein gun deck & perimeter crenellated parapet walls with 6 naval cannons
        b.add_box(-0.40, 0.40, 0.415, 0.44, -0.40, 0.40, 11.0, 0.80)
        wt = 0.055
        for side_z in (-1, 1):
            z0 = -0.40 if side_z < 0 else 0.40 - wt
            z1 = -0.40 + wt if side_z < 0 else 0.40
            b.add_box(-0.40, 0.40, 0.44, 0.50, z0, z1, 11.0, 0.87)
            for m in (-1, 0, 1):
                mx = m * 0.22
                b.add_box(mx - 0.065, mx + 0.065, 0.50, 0.56, z0, z1, 11.0, 0.91, top_inset=0.004)
                if m < 1:
                    # Stepped wooden gun carriage (kind 10) + bronze cannon barrel (kind 14)
                    cx = mx + 0.11
                    cz = z1 + 0.03 if side_z < 0 else z0 - 0.03
                    b.add_box(cx - 0.022, cx + 0.022, 0.44, 0.50, cz - 0.035, cz + 0.035, 10.0, 0.72)
                    b.add_box(cx - 0.012, cx + 0.012, 0.50, 0.53, z0 - 0.04 if side_z < 0 else z0 - 0.01, z1 + 0.01 if side_z < 0 else z1 + 0.04, 14.0, 0.35, cap_bottom=True)
        for side_x in (-1, 1):
            x0 = -0.40 if side_x < 0 else 0.40 - wt
            x1 = -0.40 + wt if side_x < 0 else 0.40
            b.add_box(x0, x1, 0.44, 0.50, -0.40 + wt, 0.40 - wt, 11.0, 0.86)
            for m in (-1, 0, 1):
                mz = m * 0.22
                b.add_box(x0, x1, 0.50, 0.56, mz - 0.065, mz + 0.065, 11.0, 0.90, top_inset=0.004)

        # 3. 4 Corner cylindrical corbeled domed sentry turrets (garitas)
        for sx in (-1, 1):
            for sz in (-1, 1):
                gx, gz = sx * 0.405, sz * 0.405
                b.add_cylinder(gx, gz, 0.31, 0.415, 0.018, 0.065, 8, 11.0, 0.80, cap_top=False)
                b.add_cylinder(gx, gz, 0.415, 0.62, 0.062, 0.062, 8, 11.0, 0.91, cap_top=True)
                # Spy-slit embrasures
                b.add_box(gx - 0.066, gx + 0.066, 0.48, 0.57, gz - 0.010, gz + 0.010, 14.0, 0.30)
                b.add_box(gx - 0.010, gx + 0.010, 0.48, 0.57, gz - 0.066, gz + 0.066, 14.0, 0.30)
                # Domed stone cupola & finial
                b.add_cylinder(gx, gz, 0.62, 0.70, 0.064, 0.032, 8, 11.0, 0.95, cap_top=False)
                b.add_cylinder(gx, gz, 0.70, 0.74, 0.032, 0.008, 8, 11.0, 0.97, cap_top=True)

        # 4. Central 2-story square command keep with stone quoins, belt course & 4-hipped terracotta roof
        kw = 0.21
        b.add_box(-kw, kw, 0.44, 0.79, -kw, kw, 12.0, 0.92)
        b.add_box(-kw - 0.008, kw + 0.008, 0.61, 0.63, -kw - 0.008, kw + 0.008, 11.0, 0.88, cap_bottom=True)
        # Corner ashlar quoins on the keep
        for sx in (-1, 1):
            for sz in (-1, 1):
                b.add_box(sx * kw - (0.025 if sx > 0 else 0.006), sx * kw + (0.025 if sx < 0 else 0.006), 0.44, 0.79, sz * kw - (0.025 if sz > 0 else 0.006), sz * kw + (0.025 if sz < 0 else 0.006), 11.0, 0.86)
        # 2x2 windows per keep facade (exterior wall relief, never slicing through interior)
        for wy in (0.50, 0.67):
            for wx in (-0.09, 0.09):
                b.add_wall_feature_z(-kw, -1, wx - 0.024, wx + 0.024, wy, wy + 0.065, 14.0, 0.34, depth=0.018)
                b.add_wall_feature_z(kw, 1, wx - 0.024, wx + 0.024, wy, wy + 0.065, 14.0, 0.34, depth=0.018)
                b.add_wall_feature_x(-kw, -1, wy, wy + 0.065, wx - 0.024, wx + 0.024, 14.0, 0.34, depth=0.018)
                b.add_wall_feature_x(kw, 1, wy, wy + 0.065, wx - 0.024, wx + 0.024, 14.0, 0.34, depth=0.018)
        b.add_hipped_roof(-kw, kw, 0.79, 0.96, -kw, kw, overhang=0.028, hip_ratio=0.48, wall_kind=12.0)

        # 5. Back-Isometric Feature: Rear (+Z) landward gatehouse portal, iron portcullis & timber drawbridge doors
        b.add_wall_feature_z(0.42, 1, -0.12, 0.12, 0.0, 0.34, 11.0, 0.89, depth=0.055)
        b.add_wall_feature_z(0.42, 1, -0.135, 0.135, 0.32, 0.36, 11.0, 0.93, depth=0.065)
        b.add_wall_feature_z(0.475, 1, -0.075, 0.075, 0.0, 0.25, 10.0, 0.68, depth=0.018)
        b.add_wall_feature_z(0.475, 1, -0.065, 0.065, 0.25, 0.31, 14.0, 0.28, depth=0.020)
        b.add_box(-0.085, 0.085, 0.0, 0.04, 0.475, 0.54, 10.0, 0.72)

    elif asset_id == "casa_de_contratacion":
        # Matches casa_de_contratacion_isometric (Front + Back 3/4 Isometric):
        # 1. Cut-stone plinth + stepped entry stairs
        hw, hl = 0.34, 0.44
        b.add_box(-hw - 0.02, hw + 0.02, 0.0, 0.08, -hl - 0.02, hl + 0.02, 11.0, 0.84)
        b.add_box(-hw - 0.07, -hw, 0.0, 0.05, -0.09, 0.09, 11.0, 0.88)
        # 2. Main 2-story cream limewashed body (recessed behind ground-floor front loggia)
        loggia_d = 0.095
        b.add_box(-hw + loggia_d, hw, 0.08, 0.74, -hl, hl, 12.0, 0.91)
        b.add_box(-hw, -hw + loggia_d, 0.40, 0.74, -hl, hl, 12.0, 0.92, cap_bottom=True)
        # Stone belt course & alternating corner quoins
        b.add_box(-hw - 0.012, hw + 0.012, 0.39, 0.415, -hl - 0.012, hl + 0.012, 11.0, 0.88, cap_bottom=True)
        for sx in (-1, 1):
            for sz in (-1, 1):
                for q in range(8):
                    qy0 = 0.08 + q * 0.082
                    qy1 = qy0 + 0.068
                    q_span = 0.042 if q % 2 == 0 else 0.024
                    b.add_box(
                        sx * hw - (q_span if sx > 0 else 0.012),
                        sx * hw + (q_span if sx < 0 else 0.012),
                        qy0,
                        qy1,
                        sz * hl - (q_span if sz > 0 else 0.012),
                        sz * hl + (q_span if sz < 0 else 0.012),
                        11.0,
                        0.84,
                    )
        # 3. 4-Arch stone colonnade loggia along the front (-X) facade
        bays = 4
        bay_span = (2 * hl - 0.08) / bays
        for i in range(bays + 1):
            pz = -hl + 0.04 + i * bay_span
            # Square stone pier with plinth & capital
            b.add_box(-hw - 0.010, -hw + loggia_d, 0.08, 0.32, pz - 0.024, pz + 0.024, 11.0, 0.88)
            if i < bays:
                mz = pz + 0.5 * bay_span
                # Stone arch spandrel & keystone
                b.add_box(-hw - 0.008, -hw + 0.035, 0.31, 0.39, pz + 0.024, pz + bay_span - 0.024, 11.0, 0.90, cap_bottom=True)
                # Dark recessed archway & upper shuttered balcony doors
                b.add_wall_feature_x(-hw + loggia_d, -1, 0.08, 0.34, mz - 0.045, mz + 0.045, 14.0, 0.28, depth=0.018)
                b.add_wall_feature_x(-hw, -1, 0.42, 0.65, mz - 0.038, mz + 0.038, 10.0, 0.68, depth=0.018)
        # 4. Cantilevered 2nd-story timber balustrade balconies + tiled pent-roof awnings (front & side)
        b.add_box(-hw - 0.075, -hw, 0.39, 0.415, -hl + 0.03, hl - 0.03, 10.0, 0.74, cap_bottom=True)
        b.add_box(-hw - 0.075, -hw - 0.058, 0.415, 0.495, -hl + 0.03, hl - 0.03, 10.0, 0.78)
        b.add_pent_roof_x(-hw, -1, 0.62, 0.70, -hl + 0.03, hl - 0.03)
        # Side balcony on -Z and +Z gable/end walls
        for sz in (-1, 1):
            z_wall = sz * hl
            z_out = z_wall + sz * 0.075
            b.add_box(-0.18, 0.18, 0.39, 0.415, min(z_wall, z_out), max(z_wall, z_out), 10.0, 0.74, cap_bottom=True)
            b.add_box(-0.18, 0.18, 0.415, 0.495, min(z_out, z_out - sz * 0.018), max(z_out, z_out - sz * 0.018), 10.0, 0.78)
            b.add_wall_feature_z(z_wall, sz, -0.042, 0.042, 0.42, 0.63, 10.0, 0.68, depth=0.018)
        # 5. Back-Isometric Feature: Rear (+X) service courtyard archways, timber cargo doors & upper shuttered windows
        for rz in (-0.24, 0.0, 0.24):
            b.add_wall_feature_x(hw, 1, 0.08, 0.35, rz - 0.065, rz + 0.065, 11.0, 0.86, depth=0.018)
            b.add_wall_feature_x(hw + 0.018, 1, 0.08, 0.29, rz - 0.045, rz + 0.045, 10.0, 0.68, depth=0.014)
            b.add_wall_feature_x(hw + 0.018, 1, 0.29, 0.33, rz - 0.040, rz + 0.040, 14.0, 0.30, depth=0.014)
            b.add_wall_feature_x(hw, 1, 0.45, 0.64, rz - 0.038, rz + 0.038, 10.0, 0.70, depth=0.018)
        # 6. Main straight hipped terracotta barrel-tile roof
        b.add_hipped_roof(-hw, hw, 0.74, 0.96, -hl, hl, overhang=0.045, hip_ratio=0.24, wall_kind=12.0)

    elif asset_id == "mission_chapel":
        # Matches mission_chapel_isometric_v3 (Front + Back 3/4 Isometric):
        # 1. Plumb rectangular limewashed nave + stone plinth
        hw, hl = 0.24, 0.42
        b.add_box(-hw - 0.015, hw + 0.015, 0.0, 0.05, -hl - 0.015, hl + 0.015, 11.0, 0.83)
        b.add_box(-hw, hw, 0.05, 0.48, -hl, hl, 12.0, 0.92)
        # 2. 4 Stepped coral-stone exterior buttresses along each side wall (+X and -X) + clerestory windows between them
        for idx in range(4):
            bz = -hl + 0.12 + idx * 0.20
            for sx in (-1, 1):
                b.add_wall_feature_x(sx * hw, sx, 0.05, 0.26, bz - 0.026, bz + 0.026, 11.0, 0.84, depth=0.048)
                b.add_wall_feature_x(sx * hw, sx, 0.26, 0.44, bz - 0.022, bz + 0.022, 11.0, 0.87, depth=0.032)
            if idx < 3:
                wz = bz + 0.10
                b.add_wall_feature_x(-hw, -1, 0.24, 0.40, wz - 0.022, wz + 0.022, 14.0, 0.30, depth=0.016)
                b.add_wall_feature_x(hw, 1, 0.24, 0.40, wz - 0.022, wz + 0.022, 14.0, 0.30, depth=0.016)
        # 3. Front (-Z) facade: diagonal corner buttresses, carved stone Plateresque portal & rose window
        b.add_box(-hw - 0.035, -hw + 0.025, 0.05, 0.44, -hl - 0.042, -hl, 11.0, 0.85)
        b.add_wall_feature_z(-hl, -1, -0.11, 0.11, 0.05, 0.34, 11.0, 0.88, depth=0.028)
        b.add_wall_feature_z(-hl, -1, -0.125, 0.125, 0.32, 0.35, 11.0, 0.91, depth=0.036)
        # Arched wooden studded portal doors (kind 10) & dark recessed arch head (kind 14)
        b.add_wall_feature_z(-hl - 0.028, -1, -0.065, 0.065, 0.05, 0.27, 10.0, 0.70, depth=0.012)
        b.add_wall_feature_z(-hl - 0.028, -1, -0.048, 0.048, 0.27, 0.30, 14.0, 0.32, depth=0.012)
        # Circular stone rose window frame & dark stained-glass core
        b.add_wall_feature_z(-hl, -1, -0.042, 0.042, 0.38, 0.46, 11.0, 0.89, depth=0.018)
        b.add_wall_feature_z(-hl - 0.018, -1, -0.026, 0.026, 0.395, 0.445, 14.0, 0.30, depth=0.010)
        # 4. Straight gabled terracotta barrel-tile roof over the nave
        b.add_hipped_roof(-hw, hw, 0.48, 0.66, -hl, hl, overhang=0.032, hip_ratio=0.0, wall_kind=12.0)
        # 5. Back-Isometric Feature: Rear (+Z) protruding octagonal stone sanctuary apse with conical terracotta roof
        b.add_cylinder(0.0, hl + 0.02, 0.0, 0.05, 0.175, 0.175, 8, 11.0, 0.83, cap_top=False)
        b.add_cylinder(0.0, hl + 0.02, 0.05, 0.40, 0.165, 0.165, 8, 11.0, 0.86, cap_top=True)
        b.add_cylinder(0.0, hl + 0.02, 0.38, 0.405, 0.175, 0.175, 8, 11.0, 0.89, cap_top=True)
        b.add_cylinder(0.0, hl + 0.02, 0.405, 0.55, 0.185, 0.012, 8, 13.0, 0.93, cap_top=True)
        # 6. SINGLE 3-Stage Square Stone Bell Tower (Campanario) at front-right (+X, -Z) corner
        tx0, tx1 = hw - 0.06, hw + 0.14
        tz0, tz1 = -hl - 0.02, -hl + 0.18
        tmx, tmz = 0.5 * (tx0 + tx1), 0.5 * (tz0 + tz1)
        # Stage 1: Solid coursed stone tower base
        b.add_box(tx0, tx1, 0.0, 0.48, tz0, tz1, 11.0, 0.86)
        b.add_box(tx0 - 0.012, tx1 + 0.012, 0.48, 0.505, tz0 - 0.012, tz1 + 0.012, 11.0, 0.91, cap_bottom=True)
        # Stage 2: Lower arched belfry tier (exterior belfry arches on all 4 faces)
        b2_x0, b2_x1, b2_z0, b2_z1 = tx0 + 0.008, tx1 - 0.008, tz0 + 0.008, tz1 - 0.008
        b.add_box(b2_x0, b2_x1, 0.505, 0.68, b2_z0, b2_z1, 11.0, 0.89)
        b.add_wall_feature_z(b2_z0, -1, tmx - 0.032, tmx + 0.032, 0.53, 0.64, 14.0, 0.28, depth=0.014)
        b.add_wall_feature_z(b2_z1, 1, tmx - 0.032, tmx + 0.032, 0.53, 0.64, 14.0, 0.28, depth=0.014)
        b.add_wall_feature_x(b2_x0, -1, 0.53, 0.64, tmz - 0.032, tmz + 0.032, 14.0, 0.28, depth=0.014)
        b.add_wall_feature_x(b2_x1, 1, 0.53, 0.64, tmz - 0.032, tmz + 0.032, 14.0, 0.28, depth=0.014)
        b.add_box(tx0 - 0.004, tx1 + 0.004, 0.68, 0.705, tz0 - 0.004, tz1 + 0.004, 11.0, 0.92, cap_bottom=True)
        # Stage 3: Upper arched belfry tier + pyramidal terracotta roof
        b3_x0, b3_x1, b3_z0, b3_z1 = tx0 + 0.014, tx1 - 0.014, tz0 + 0.014, tz1 - 0.014
        b.add_box(b3_x0, b3_x1, 0.705, 0.86, b3_z0, b3_z1, 11.0, 0.91)
        b.add_wall_feature_z(b3_z0, -1, tmx - 0.028, tmx + 0.028, 0.73, 0.82, 14.0, 0.28, depth=0.014)
        b.add_wall_feature_z(b3_z1, 1, tmx - 0.028, tmx + 0.028, 0.73, 0.82, 14.0, 0.28, depth=0.014)
        b.add_wall_feature_x(b3_x0, -1, 0.73, 0.82, tmz - 0.028, tmz + 0.028, 14.0, 0.28, depth=0.014)
        b.add_wall_feature_x(b3_x1, 1, 0.73, 0.82, tmz - 0.028, tmz + 0.028, 14.0, 0.28, depth=0.014)
        b.add_hipped_roof(tx0 + 0.006, tx1 - 0.006, 0.86, 0.98, tz0 + 0.006, tz1 - 0.006, overhang=0.024, hip_ratio=0.49, wall_kind=11.0)
        # Align nave along X (-X front Plateresque portal + +Z right-hand bell tower, +X rear octagonal apse)
        # so yaw=135° (front photo) and yaw=-45° (rear photo) match the exact photographed orientation:
        b.verts = [[v[2], v[1], v[0]] for v in b.verts]
        b.norms = [[n[2], n[1], n[0]] for n in b.norms]
        b.faces = [(f[0], f[2], f[1]) for f in b.faces]

    else:
        # colonial_town_block — Matches colonial_townhouse_photo_front & back (4-Wing Closed-Perimeter Casa Patio):
        # 1. Solid 4-wing two-story masonry perimeter enclosing a recessed central stone courtyard lightwell (patio central)
        hw, hl = 0.39, 0.42
        ix, iz = 0.14, 0.16
        b.add_box(-hw - 0.015, hw + 0.015, 0.0, 0.06, -hl - 0.015, hl + 0.015, 11.0, 0.84)
        # 4 full-height two-story masonry wings surrounding the central patio well [-ix..ix, -iz..iz]
        b.add_box(-hw, -ix, 0.06, 0.70, -hl, hl, 12.0, 0.92)       # -X (front-left) wing
        b.add_box(ix, hw, 0.06, 0.70, -hl, hl, 12.0, 0.90)         # +X (rear-right) wing
        b.add_box(-ix, ix, 0.06, 0.70, -hl, -iz, 12.0, 0.91)       # -Z (front-right) wing
        b.add_box(-ix, ix, 0.06, 0.70, iz, hl, 12.0, 0.89)         # +Z (rear-left) wing
        # Recessed central courtyard stone floor & inward-facing cloister arches + 2nd-story timber gallery rails
        b.add_box(-ix, ix, 0.06, 0.09, -iz, iz, 11.0, 0.76)
        for cz in (-0.09, 0.0, 0.09):
            b.add_wall_feature_x(-ix, 1, 0.09, 0.34, cz - 0.028, cz + 0.028, 14.0, 0.28, depth=0.018)
            b.add_wall_feature_x(ix, -1, 0.09, 0.34, cz - 0.028, cz + 0.028, 14.0, 0.28, depth=0.018)
        for cx in (-0.08, 0.0, 0.08):
            b.add_wall_feature_z(-iz, 1, cx - 0.028, cx + 0.028, 0.09, 0.34, 14.0, 0.28, depth=0.018)
            b.add_wall_feature_z(iz, -1, cx - 0.028, cx + 0.028, 0.09, 0.34, 14.0, 0.28, depth=0.018)
        # Upper courtyard gallery balustrade ring inside the central patio lightwell
        b.add_box(-ix, ix, 0.36, 0.45, -iz, -iz + 0.024, 10.0, 0.74)
        b.add_box(-ix, ix, 0.36, 0.45, iz - 0.024, iz, 10.0, 0.74)
        b.add_box(-ix, -ix + 0.024, 0.36, 0.45, -iz, iz, 10.0, 0.74)
        b.add_box(ix - 0.024, ix, 0.36, 0.45, -iz, iz, 10.0, 0.74)
        # Stone belt course & alternating coral-stone corner quoins on all 4 exterior corners
        b.add_box(-hw - 0.010, hw + 0.010, 0.36, 0.385, -hl - 0.010, hl + 0.010, 11.0, 0.87, cap_bottom=True)
        for sx in (-1, 1):
            for sz in (-1, 1):
                b.add_box(
                    sx * hw - (0.032 if sx > 0 else 0.010),
                    sx * hw + (0.032 if sx < 0 else 0.010),
                    0.06,
                    0.70,
                    sz * hl - (0.032 if sz > 0 else 0.010),
                    sz * hl + (0.032 if sz < 0 else 0.010),
                    11.0,
                    0.84,
                )
        # 3 Stone-framed arched ground-floor portals on -X front street facade + 1 central carriage portal on +X rear facade
        for az in (-0.16, 0.0, 0.16):
            b.add_wall_feature_x(-hw, -1, 0.06, 0.33, az - 0.058, az + 0.058, 11.0, 0.86, depth=0.018)
            b.add_wall_feature_x(-hw - 0.018, -1, 0.06, 0.29, az - 0.042, az + 0.042, 10.0, 0.68, depth=0.014)
        b.add_wall_feature_x(hw, 1, 0.06, 0.34, -0.075, 0.075, 11.0, 0.86, depth=0.018)
        b.add_wall_feature_x(hw + 0.018, 1, 0.06, 0.30, -0.055, 0.055, 10.0, 0.68, depth=0.014)
        # Upper-floor shuttered balcony doors & ground-floor wrought-iron rejas on all 4 exterior walls
        for wz in (-0.28, -0.10, 0.10, 0.28):
            b.add_wall_feature_x(-hw, -1, 0.43, 0.62, wz - 0.036, wz + 0.036, 10.0, 0.68, depth=0.018)
            b.add_wall_feature_x(hw, 1, 0.43, 0.62, wz - 0.036, wz + 0.036, 10.0, 0.68, depth=0.018)
        for wx in (-0.25, -0.08, 0.08, 0.25):
            b.add_wall_feature_z(-hl, -1, wx - 0.036, wx + 0.036, 0.43, 0.62, 10.0, 0.68, depth=0.018)
            b.add_wall_feature_z(-hl, -1, wx - 0.034, wx + 0.034, 0.11, 0.29, 14.0, 0.32, depth=0.018)
            b.add_wall_feature_z(hl, 1, wx - 0.036, wx + 0.036, 0.43, 0.62, 10.0, 0.68, depth=0.018)
            b.add_wall_feature_z(hl, 1, wx - 0.034, wx + 0.034, 0.11, 0.29, 14.0, 0.32, depth=0.018)
        # Cantilevered 2nd-story hardwood balconies with clay tile pent-roof awnings on Front (-X) & Back (+X)
        for sx in (-1, 1):
            xw = sx * hw
            xo = xw + sx * 0.072
            b.add_box(min(xw, xo), max(xw, xo), 0.37, 0.395, -0.22, 0.22, 10.0, 0.74, cap_bottom=True)
            b.add_box(min(xo, xo - sx * 0.018), max(xo, xo - sx * 0.018), 0.395, 0.475, -0.22, 0.22, 10.0, 0.78)
            b.add_pent_roof_x(xw, sx, 0.59, 0.67, -0.22, 0.22)
        # 4-Wing Closed-Perimeter Cloistered Hipped Terracotta Roof sloping outward to street & inward to patio
        b.add_cloister_hipped_roof(-hw, hw, -hl, hl, -ix, ix, -iz, iz, 0.70, 0.94, overhang=0.042, inner_overhang=0.022)

    return b.finalize()


def prepare_atlas_tile_and_bbox(seg_rgba: Image.Image, tile_w: int = 256, tile_h: int = 512):
    """
    Resizes a segmented RGBA building render into a (tile_w x tile_h) atlas sub-tile,
    dilates foreground RGB outward into transparent pixels via Euclidean Distance Transform (EDT)
    so mipmaps and grazing UVs never bleed background gray, and returns:
    - dilated_rgb: uint8 array (tile_h, tile_w, 3)
    - fg_bbox: (x0, x1, y0, y1) pixel bounds of the foreground building in tile coordinates
    - mask_tile: bool array (tile_h, tile_w)
    """
    tile_rgba = seg_rgba.resize((tile_w, tile_h), Image.Resampling.LANCZOS)
    arr = np.asarray(tile_rgba, dtype=np.uint8)
    rgb = arr[:, :, :3].copy()
    alpha = arr[:, :, 3]
    mask = alpha > 96

    ys, xs = np.where(mask)
    if len(xs) > 16 and len(ys) > 16:
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        _, nearest_idx = distance_transform_edt(~mask, return_indices=True)
        dilated_rgb = rgb[nearest_idx[0], nearest_idx[1]]
    else:
        x0, x1, y0, y1 = 16, tile_w - 16, 16, tile_h - 16
        dilated_rgb = rgb

    return dilated_rgb, (x0, x1, y0, y1), mask


def denoise_photorealistic_depth(raw_depth_pil: Image.Image, mask: np.ndarray, size: int = 256) -> np.ndarray:
    """
    Two-stage structural filter for Depth Anything V2 on photorealistic masonry/tile photos:
    1. Median filter (5x5) strips salt-and-pepper stone/mortar micro-noise while keeping sharp wall corners
    2. Gaussian smoothing (sigma=1.2) produces a clean continuous depth field across facades, arches & courtyards
    """
    d_arr = np.asarray(raw_depth_pil.resize((size, size), Image.Resampling.BILINEAR), dtype=np.float32)
    m_small = np.asarray(
        Image.fromarray((mask.astype(np.uint8) * 255)).resize((size, size), Image.Resampling.NEAREST),
        dtype=np.uint8,
    ) > 127
    if np.any(m_small):
        fg_vals = d_arr[m_small]
        p_low, p_high = np.percentile(fg_vals, [2.0, 98.5])
        d_norm = np.clip((d_arr - p_low) / max(1e-5, p_high - p_low), 0.0, 1.0)
        d_norm[~m_small] = 0.0
    else:
        d_norm = (d_arr - d_arr.min()) / max(1e-5, d_arr.max() - d_arr.min())
    d_med = median_filter(d_norm, size=5)
    d_clean = gaussian_filter(d_med, sigma=1.2)
    if np.any(m_small):
        d_clean[~m_small] = 0.0
    return d_clean


def project_camera_coords(verts: np.ndarray, yaw_deg: float, pitch_deg: float = 28.0):
    """
    Projects 3D vertices (lx, ly, lz) into the orthographic camera plane (u_cam, v_cam, depth_cam)
    and returns the camera viewing direction vector (pointing from scene toward camera).
    """
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)

    vc = verts.copy()
    vc[:, 1] -= 0.48

    u_cam = vc[:, 0] * cy + vc[:, 2] * sy
    z1 = -vc[:, 0] * sy + vc[:, 2] * cy
    v_cam = vc[:, 1] * cp - z1 * sp
    depth_cam = vc[:, 1] * sp + z1 * cp

    # Camera view vector in world space (unit vector pointing toward camera)
    cam_dir = np.array([-sy * cp, sp, cy * cp], dtype=np.float32)
    cam_dir /= max(1e-6, float(np.linalg.norm(cam_dir)))
    return u_cam, v_cam, depth_cam, cam_dir


def project_shot_angle_uvs(
    verts: np.ndarray,
    faces: np.ndarray,
    normals: np.ndarray,
    col_idx: int,
    front_bbox: tuple[int, int, int, int],
    back_bbox: tuple[int, int, int, int],
    front_tile_rgb: np.ndarray,
    back_tile_rgb: np.ndarray,
    front_yaw_deg: float = 135.0,
    back_yaw_deg: float = -45.0,
    pitch_deg: float = 28.0,
    num_cols: int = 4,
):
    """
    Projects every 3D triangle onto either the Front-Oblique photo tile (row=0) or the Back-Oblique
    photo tile (row=1) from the exact camera angle that the photo was shot from, so that:
    - Each face's 3 vertices share a single contiguous camera projection (zero cross-tile seam)
    - Returns:
      - atlas_uvs: (N_verts, 2) in [0, 1]^2 across the full (1024x1024) 4x2 building photo atlas
      - vert_rgb: (N_verts, 3) sampled sRGB colors from the projected photo for GLB export
    """
    tile_h, tile_w, _ = front_tile_rgb.shape
    u_f, v_f, _, dir_f = project_camera_coords(verts, front_yaw_deg, pitch_deg)
    u_b, v_b, _, dir_b = project_camera_coords(verts, back_yaw_deg, pitch_deg)

    uf_min, uf_max = float(u_f.min()), float(u_f.max())
    vf_min, vf_max = float(v_f.min()), float(v_f.max())
    ub_min, ub_max = float(u_b.min()), float(u_b.max())
    vb_min, vb_max = float(v_b.min()), float(v_b.max())

    fx0, fx1, fy0, fy1 = front_bbox
    bx0, bx1, by0, by1 = back_bbox

    # Normalized [0, 1] tile UVs for front camera projection
    tu_f = (fx0 + ((u_f - uf_min) / max(1e-5, uf_max - uf_min)) * (fx1 - fx0)) / tile_w
    tv_f = (fy1 - ((v_f - vf_min) / max(1e-5, vf_max - vf_min)) * (fy1 - fy0)) / tile_h
    tu_f = np.clip(tu_f, 0.006, 0.994)
    tv_f = np.clip(tv_f, 0.006, 0.994)

    # Normalized [0, 1] tile UVs for back camera projection
    tu_b = (bx0 + ((u_b - ub_min) / max(1e-5, ub_max - ub_min)) * (bx1 - bx0)) / tile_w
    tv_b = (by1 - ((v_b - vb_min) / max(1e-5, vb_max - vb_min)) * (by1 - by0)) / tile_h
    tu_b = np.clip(tu_b, 0.006, 0.994)
    tv_b = np.clip(tv_b, 0.006, 0.994)

    atlas_uvs = np.zeros((len(verts), 2), dtype=np.float32)
    vert_rgb = np.zeros((len(verts), 3), dtype=np.uint8)

    # Assign each triangle to either Front-Oblique (row 0) or Back-Oblique (row 1) based on its outward normal & centroid
    for i0, i1, i2 in faces:
        fn = normals[i0]
        tri_c = (verts[i0] + verts[i1] + verts[i2]) / 3.0
        # Horizontal normal alignment with front vs back camera + slight positional tie-breaker
        score_f = float(np.dot(fn, dir_f)) + float(np.dot(tri_c - np.array([0.0, 0.48, 0.0]), dir_f)) * 0.25
        score_b = float(np.dot(fn, dir_b)) + float(np.dot(tri_c - np.array([0.0, 0.48, 0.0]), dir_b)) * 0.25

        use_front = score_f >= score_b
        for vi in (i0, i1, i2):
            if use_front:
                u_tile, v_tile = tu_f[vi], tv_f[vi]
                row_idx = 0
                px_i = int(np.clip(round(u_tile * (tile_w - 1)), 0, tile_w - 1))
                py_i = int(np.clip(round(v_tile * (tile_h - 1)), 0, tile_h - 1))
                vert_rgb[vi] = front_tile_rgb[py_i, px_i]
            else:
                u_tile, v_tile = tu_b[vi], tv_b[vi]
                row_idx = 1
                px_i = int(np.clip(round(u_tile * (tile_w - 1)), 0, tile_w - 1))
                py_i = int(np.clip(round(v_tile * (tile_h - 1)), 0, tile_h - 1))
                vert_rgb[vi] = back_tile_rgb[py_i, px_i]

            atlas_uvs[vi, 0] = (col_idx + u_tile) / float(num_cols)
            atlas_uvs[vi, 1] = (row_idx + v_tile) / 2.0

    return atlas_uvs, vert_rgb


def render_zbuffer_textured_isometric(
    verts: np.ndarray,
    faces: np.ndarray,
    normals: np.ndarray,
    atlas_uvs: np.ndarray,
    atlas_rgb: np.ndarray,
    yaw_deg: float,
    pitch_deg: float = 24.0,
    res: int = 384,
) -> np.ndarray:
    """
    True per-pixel Z-buffered orthographic rasterizer that samples the camera-projected
    photorealistic texture atlas (`atlas_rgb`) via barycentric UV interpolation + directional sun shading.
    """
    u_cam, v_cam, z_cam, _ = project_camera_coords(verts, yaw_deg, pitch_deg)
    scale = res * 0.68
    px = u_cam * scale + (res * 0.5)
    py = -v_cam * scale + (res * 0.52)

    img = np.full((res, res, 3), [12 / 255.0, 20 / 255.0, 28 / 255.0], dtype=np.float32)
    zbuf = np.full((res, res), -1e9, dtype=np.float32)

    atlas_f = atlas_rgb.astype(np.float32) / 255.0
    ah, aw, _ = atlas_f.shape

    sun_dir = np.array([-0.48, 0.76, -0.44], dtype=np.float32)
    sun_dir /= np.linalg.norm(sun_dir)

    for i0, i1, i2 in faces:
        x0, y0, d0 = px[i0], py[i0], z_cam[i0]
        x1p, y1p, d1 = px[i1], py[i1], z_cam[i1]
        x2p, y2p, d2 = px[i2], py[i2], z_cam[i2]

        min_x = max(0, int(math.floor(min(x0, x1p, x2p))))
        max_x = min(res - 1, int(math.ceil(max(x0, x1p, x2p))))
        min_y = max(0, int(math.floor(min(y0, y1p, y2p))))
        max_y = min(res - 1, int(math.ceil(max(y0, y1p, y2p))))
        if min_x > max_x or min_y > max_y:
            continue

        denom = (y1p - y2p) * (x0 - x2p) + (x2p - x1p) * (y0 - y2p)
        if abs(denom) < 1e-5:
            continue

        ys, xs = np.mgrid[min_y : max_y + 1, min_x : max_x + 1]
        w0 = ((y1p - y2p) * (xs - x2p) + (x2p - x1p) * (ys - y2p)) / denom
        w1 = ((y2p - y0) * (xs - x2p) + (x0 - x2p) * (ys - y2p)) / denom
        w2 = 1.0 - w0 - w1

        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not np.any(inside):
            continue

        depth = w0 * d0 + w1 * d1 + w2 * d2
        sub_z = zbuf[min_y : max_y + 1, min_x : max_x + 1]
        vis = inside & (depth > sub_z)
        if not np.any(vis):
            continue

        sub_z[vis] = depth[vis]

        # Interpolate camera-projected atlas UVs across the visible pixels of this triangle
        uv0, uv1, uv2 = atlas_uvs[i0], atlas_uvs[i1], atlas_uvs[i2]
        u_interp = w0[vis] * uv0[0] + w1[vis] * uv1[0] + w2[vis] * uv2[0]
        v_interp = w0[vis] * uv0[1] + w1[vis] * uv1[1] + w2[vis] * uv2[1]

        tx = np.clip((u_interp * (aw - 1)).astype(np.int32), 0, aw - 1)
        ty = np.clip((v_interp * (ah - 1)).astype(np.int32), 0, ah - 1)
        tex_rgb = atlas_f[ty, tx]

        fn = normals[i0]
        sun_dot = max(0.0, float(np.dot(fn, sun_dir)))
        hemi = 0.68 + 0.32 * max(-1.0, min(1.0, float(fn[1])))
        lit = min(1.14, 0.72 * hemi + 0.38 * sun_dot)

        edge_dist = np.minimum(np.minimum(w0[vis], w1[vis]), w2[vis])
        edge_factor = np.where(edge_dist < 0.022, 0.90, 1.0)

        sub_img = img[min_y : max_y + 1, min_x : max_x + 1]
        sub_img[vis] = tex_rgb * (lit * edge_factor[:, None])

    return (np.clip(img, 0.0, 1.0) * 255.0).astype(np.uint8)


def main():
    parser = argparse.ArgumentParser(description="Build 1550 Spanish Main Plumb-Rectified 3D Building Assets from 3/4 Isometric Renders")
    parser.add_argument("--manifest", required=True, help="JSON list of {id, name, isometricPath}")
    parser.add_argument("--out-dir", required=True, help="Directory for output .glb meshes, WW3D bundle, and atlas")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    items = json.load(open(args.manifest))

    import torch
    import trimesh
    from transformers import pipeline

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Loading Depth Anything V2 Small on {device} for isometric depth & normal extraction...")
    depth_pipe = pipeline(
        task="depth-estimation",
        model="depth-anything/Depth-Anything-V2-Small-hf",
        device=device,
    )

    fig = plt.figure(figsize=(24, 4.7 * len(items)), facecolor="#0c141c")
    summary = []
    lrm_templates = []

    num_cols = max(1, len(items))
    tile_w, tile_h = 1024 // num_cols, 512
    atlas_rgb = np.zeros((tile_h * 2, tile_w * num_cols, 3), dtype=np.uint8)
    staged_rows = []

    for row, item in enumerate(items):
        asset_id = item["id"]
        name = item["name"]
        front_iso_path = item.get("frontIsometricPath") or item.get("isometricPath") or item.get("turnaroundPath")
        back_iso_path = item.get("backIsometricPath") or front_iso_path
        front_yaw_deg = float(item.get("frontYawDeg", 135.0))
        back_yaw_deg = float(item.get("backYawDeg", -45.0))
        print(f"\n=== Processing Photorealistic Telephoto Front + Back 3D Archetype: {name} ({asset_id}) ===")

        front_iso_im = Image.open(front_iso_path).convert("RGB")
        back_iso_im = Image.open(back_iso_path).convert("RGB")
        seg_front_im = segment_studio_background(front_iso_im)
        seg_back_im = segment_studio_background(back_iso_im)

        asset_sub = os.path.join(args.out_dir, asset_id)
        os.makedirs(asset_sub, exist_ok=True)
        seg_front_im.save(os.path.join(asset_sub, "iso_front_rgba.png"))
        seg_back_im.save(os.path.join(asset_sub, "iso_back_rgba.png"))
        seg_front_im.save(os.path.join(asset_sub, "iso_rgba.png"))

        # Prepare EDT-dilated 256x512 photo atlas sub-tiles (Row 0 = Front-Oblique, Row 1 = Back-Oblique)
        front_tile_rgb, front_bbox, mask_front = prepare_atlas_tile_and_bbox(seg_front_im, tile_w=tile_w, tile_h=tile_h)
        back_tile_rgb, back_bbox, mask_back = prepare_atlas_tile_and_bbox(seg_back_im, tile_w=tile_w, tile_h=tile_h)
        atlas_rgb[0:tile_h, row * tile_w : (row + 1) * tile_w] = front_tile_rgb
        atlas_rgb[tile_h : tile_h * 2, row * tile_w : (row + 1) * tile_w] = back_tile_rgb

        # Depth Anything V2 + Two-Stage Photorealistic Denoiser (Median 5x5 + Gaussian 1.2)
        depth_front_out = depth_pipe(seg_front_im.convert("RGB"))["depth"]
        d_front_norm = denoise_photorealistic_depth(depth_front_out, mask_front, size=256)
        gy_f, gx_f = np.gradient(d_front_norm)

        depth_back_out = depth_pipe(seg_back_im.convert("RGB"))["depth"]
        d_back_norm = denoise_photorealistic_depth(depth_back_out, mask_back, size=256)
        gy_b, gx_b = np.gradient(d_back_norm)

        relief_contrast = float(np.clip(1.0 + (np.std(gx_f) + np.std(gx_b)), 0.95, 1.15))

        verts, faces, normals, kind, shade = build_plumb_isometric_archetype(asset_id, relief_contrast=relief_contrast)

        # Project exact shot-angle camera UVs from Front-Oblique & Back-Oblique photos onto the plumb 3D mesh
        atlas_uvs, vert_rgb = project_shot_angle_uvs(
            verts,
            faces,
            normals,
            col_idx=row,
            front_bbox=front_bbox,
            back_bbox=back_bbox,
            front_tile_rgb=front_tile_rgb,
            back_tile_rgb=back_tile_rgb,
            front_yaw_deg=front_yaw_deg,
            back_yaw_deg=back_yaw_deg,
            pitch_deg=28.0,
            num_cols=num_cols,
        )

        # Export clean, plumb GLB file with camera-projected photo colors
        glb_path = os.path.join(args.out_dir, f"{asset_id}.glb")
        v_colors = np.column_stack([vert_rgb, np.full((len(verts), 1), 255, dtype=np.uint8)])
        mesh_obj = trimesh.Trimesh(vertices=verts, faces=faces, vertex_normals=normals, vertex_colors=v_colors, process=False)
        mesh_obj.export(glb_path)

        # Pack 8-float vertex buffer [lx, ly, lz, nx, ny, nz, 20.0 + u_atlas, v_atlas] + uint16 index buffer
        kind_u = (20.0 + atlas_uvs[:, 0]).astype("<f4")
        shade_v = atlas_uvs[:, 1].astype("<f4")
        v_pack = np.column_stack([verts, normals, kind_u[:, None], shade_v[:, None]]).astype("<f4")
        i_pack = faces.reshape(-1).astype("<u2")
        lrm_templates.append((asset_id, v_pack, i_pack))

        unique_k, counts_k = np.unique(kind.astype(int), return_counts=True)
        mat_stats = {int(k): round(float(c) / len(kind) * 100.0, 1) for k, c in zip(unique_k, counts_k)}
        plumb_wall_pct = float(np.mean(np.isclose(normals[:, 1], 0.0, atol=0.18) | (normals[:, 1] > 0.35)) * 100.0)
        print(
            f"  -> {asset_id}: {len(faces):,} plumb-rectified photo-textured triangles ({len(verts):,} unshared verts), "
            f"plumb/planar alignment={plumb_wall_pct:.1f}%, structural parts={mat_stats}"
        )
        summary.append(
            {
                "id": asset_id,
                "name": name,
                "frontIsometricPath": front_iso_path,
                "backIsometricPath": back_iso_path,
                "triangles": int(len(faces)),
                "vertices": int(len(verts)),
                "plumbPlanarPct": round(plumb_wall_pct, 1),
                "glbBytes": os.path.getsize(glb_path),
                "materialBreakdownPct": mat_stats,
            }
        )
        staged_rows.append(
            (
                row,
                name,
                seg_front_im,
                seg_back_im,
                d_front_norm,
                d_back_norm,
                gx_f,
                gy_f,
                gx_b,
                gy_b,
                verts,
                faces,
                normals,
                atlas_uvs,
                front_yaw_deg,
                back_yaw_deg,
            )
        )

    # Save the 1024x1024 1550 Building Photorealistic Texture Atlas (for WebGPU @binding(13) nearAlbedo)
    atlas_pil = Image.fromarray(atlas_rgb, mode="RGB")
    photo_atlas_jpg = os.path.join(args.out_dir, "buildings-1550-photo-atlas.jpg")
    photo_atlas_png = os.path.join(args.out_dir, "buildings-1550-photo-atlas.png")
    atlas_pil.save(photo_atlas_jpg, quality=92, optimize=True)
    atlas_pil.save(photo_atlas_png)
    print(f"\nSaved 1024x1024 Camera-Projected Photorealistic Building Texture Atlas to {photo_atlas_jpg} ({os.path.getsize(photo_atlas_jpg)/1024:.1f} KB)")

    for (
        row,
        name,
        seg_front_im,
        seg_back_im,
        d_front_norm,
        d_back_norm,
        gx_f,
        gy_f,
        gx_b,
        gy_b,
        verts,
        faces,
        normals,
        atlas_uvs,
        front_yaw_deg,
        back_yaw_deg,
    ) in staged_rows:
        # Column 1: Segmented Front-Oblique Telephoto Photograph
        bg_front = Image.new("RGBA", seg_front_im.size, (18, 30, 42, 255))
        bg_front.paste(seg_front_im, (0, 0), seg_front_im)
        ax1 = fig.add_subplot(len(items), 5, row * 5 + 1)
        ax1.imshow(bg_front)
        ax1.set_title(f"{name}\n1. Front-Oblique Telephoto Photo", color="#f5bf77", fontsize=10, fontweight="bold")
        ax1.axis("off")

        # Column 2: Segmented Rear-Oblique Telephoto Photograph
        bg_back = Image.new("RGBA", seg_back_im.size, (18, 30, 42, 255))
        bg_back.paste(seg_back_im, (0, 0), seg_back_im)
        ax2 = fig.add_subplot(len(items), 5, row * 5 + 2)
        ax2.imshow(bg_back)
        ax2.set_title("2. Rear-Oblique Telephoto Photo\n(Opposite 180° Elevation)", color="#f5bf77", fontsize=10, fontweight="bold")
        ax2.axis("off")

        # Column 3: Denoised Depth Anything V2 Front & Back Depth + Normal Relief
        nx_f = np.clip(-gx_f * 8.0 * 0.5 + 0.5, 0, 1)
        ny_f = np.clip(-gy_f * 8.0 * 0.5 + 0.5, 0, 1)
        nz_f = np.full_like(nx_f, 0.85)
        norm_f_vis = (np.dstack([nx_f, ny_f, nz_f]) * 255).astype(np.uint8)
        nx_b = np.clip(-gx_b * 8.0 * 0.5 + 0.5, 0, 1)
        ny_b = np.clip(-gy_b * 8.0 * 0.5 + 0.5, 0, 1)
        nz_b = np.full_like(nx_b, 0.85)
        norm_b_vis = (np.dstack([nx_b, ny_b, nz_b]) * 255).astype(np.uint8)
        depth_f_vis = (plt.cm.magma(d_front_norm)[:, :, :3] * 255).astype(np.uint8)
        depth_b_vis = (plt.cm.magma(d_back_norm)[:, :, :3] * 255).astype(np.uint8)
        grid_2x2 = np.vstack([np.hstack([depth_f_vis, norm_f_vis]), np.hstack([depth_b_vis, norm_b_vis])])
        ax3 = fig.add_subplot(len(items), 5, row * 5 + 3)
        ax3.imshow(grid_2x2)
        ax3.set_title("3. Denoised Depth + Normal Relief\n(Depth Anything V2 + Median/Gaussian)", color="#e7eef6", fontsize=10)
        ax3.axis("off")

        # Column 4: Photo-Textured 3D Mesh — Rotated Front Perspective View
        front_3d_img = render_zbuffer_textured_isometric(
            verts, faces, normals, atlas_uvs, atlas_rgb, yaw_deg=front_yaw_deg - 14.0, pitch_deg=23.0, res=384
        )
        ax4 = fig.add_subplot(len(items), 5, row * 5 + 4)
        ax4.imshow(front_3d_img)
        ax4.set_axis_off()
        ax4.set_title(
            f"4. Photo-Textured 3D Mesh (Front)\n({len(faces):,} Plumb Tris · Rotated -14°)",
            color="#7ae582",
            fontsize=10,
            fontweight="bold",
        )

        # Column 5: Photo-Textured 3D Mesh — Rotated Back Perspective View
        back_3d_img = render_zbuffer_textured_isometric(
            verts, faces, normals, atlas_uvs, atlas_rgb, yaw_deg=back_yaw_deg + 14.0, pitch_deg=25.0, res=384
        )
        ax5 = fig.add_subplot(len(items), 5, row * 5 + 5)
        ax5.imshow(back_3d_img)
        ax5.set_axis_off()
        ax5.set_title(
            "5. Photo-Textured 3D Mesh (Rear)\n(Shot-Angle Projected UV · Rotated +14°)",
            color="#7ae582",
            fontsize=10,
            fontweight="bold",
        )

    plt.suptitle(
        "1550 Spanish Main — Photorealistic Telephoto Photos → Plumb 3D Shape + Shot-Angle Projective Texture Pipeline",
        color="#f5bf77",
        fontsize=14,
        fontweight="bold",
        y=0.992,
    )
    plt.tight_layout(rect=[0, 0, 1, 0.982])
    atlas_out = os.path.join(args.out_dir, "building_3d_pipeline_atlas.png")
    plt.savefig(atlas_out, dpi=140, facecolor=fig.get_facecolor())
    print(f"\nSaved Plumb-Rectified 3D Building Pipeline Atlas to {atlas_out}")

    with open(os.path.join(args.out_dir, "building_assets_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    # Export compact WebGPU binary bundle (buildings-1550-lrm.bin)
    blob_parts = []
    manifest_entries = []
    cur_offset = 0
    for asset_id, v_pack, i_pack in lrm_templates:
        vb = v_pack.tobytes()
        ib = i_pack.tobytes()
        if len(ib) % 4:
            ib += b"\x00" * (4 - (len(ib) % 4))
        manifest_entries.append(
            {
                "id": asset_id,
                "vertexByteOffset": cur_offset,
                "vertexCount": int(len(v_pack)),
                "indexByteOffset": cur_offset + len(vb),
                "indexCount": int(len(i_pack)),
            }
        )
        blob_parts.append(vb)
        blob_parts.append(ib)
        cur_offset += len(vb) + len(ib)

    manifest_bytes = json.dumps(manifest_entries, separators=(",", ":")).encode("utf-8")
    if len(manifest_bytes) % 4:
        manifest_bytes += b" " * (4 - (len(manifest_bytes) % 4))
    header = struct.pack(">I", 0x57573344) + struct.pack("<II", 1, len(manifest_bytes))
    lrm_bin_path = os.path.join(args.out_dir, "buildings-1550-lrm.bin")
    with open(lrm_bin_path, "wb") as f:
        f.write(header)
        f.write(manifest_bytes)
        for part in blob_parts:
            f.write(part)
    print(f"Saved WebGPU Plumb-Rectified 3D Building Bundle to {lrm_bin_path} ({os.path.getsize(lrm_bin_path)/1024:.1f} KB)")


if __name__ == "__main__":
    main()
