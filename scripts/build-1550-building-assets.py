#!/usr/bin/env python3
"""
1550 Spanish Main — High-Detail Plumb Architectural 3D Asset & Material Swatch Pipeline

Builds the 4 canonical 1550 Spanish colonial port building archetypes (`stone_sea_bastion`,
`casa_de_contratacion`, `mission_chapel`, `colonial_town_block`) with:
1. Paired Front-Oblique and Rear-Oblique 300mm telephoto architectural reference renders
   + denoised Depth Anything V2 depth/normal analysis.
2. High-detail, strictly plumb 3D architectural geometry (2,000–3,600 triangles per archetype)
   featuring radial stone voussoir arches, recessed windows with wrought-iron rejas & open
   timber shutters, cantilevered corbeled timber balconies, stepped terracotta barrel-tile
   roof courses with exposed rafter tails (canecillos) & hip rolls, basilican church clerestory
   & 3-stage campanario with bronze bells, and 4-wing Casa Patio courtyard with central fountain.
3. Seamless 4-quadrant 1024x1024 photorealistic material swatch atlas (`buildings-1550-photo-atlas.jpg`)
   (Coral-Limestone Ashlar, Limewashed Stucco, Terracotta Barrel Tiles, Weathered Spanish Cedar Timber)
   plus baked 3D Ambient Occlusion (`shade`) and unshared per-face vertices (`kind` in 10..14) so
   walls, roofs, quoins, and balconies never suffer oblique-projection smearing.
"""

import argparse
import json
import math
import os
import struct
import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion, binary_fill_holes, distance_transform_edt, gaussian_filter, label, median_filter
import matplotlib.pyplot as plt


def segment_studio_background(im: Image.Image) -> Image.Image:
    rgb = np.asarray(im.convert("RGB"), dtype=np.float32)
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0, :, :], rgb[-1, :, :], rgb[:, 0, :], rgb[:, -1, :]], axis=0)
    bg_color = np.median(border, axis=0)

    dist = np.linalg.norm(rgb - bg_color[None, None, :], axis=-1)
    luma = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    chroma = np.max(rgb, axis=-1) - np.min(rgb, axis=-1)
    is_bg = (dist < 22.0) | ((dist < 34.0) & (chroma < 18.0) & (luma < 62.0))

    fg = ~is_bg
    fg = binary_fill_holes(fg)
    lbl, num = label(fg)
    if num > 0:
        counts = np.bincount(lbl.ravel())
        counts[0] = 0
        fg = lbl == int(np.argmax(counts))
    fg_eroded = binary_erosion(fg, iterations=1)
    alpha = gaussian_filter(fg_eroded.astype(np.float32), sigma=0.75)
    alpha_u8 = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    out = np.dstack([ np.asarray(im.convert("RGB"), dtype=np.uint8), alpha_u8 ])
    return Image.fromarray(out, mode="RGBA")


def denoise_photorealistic_depth(raw_depth_pil: Image.Image, mask: np.ndarray, size: int = 256) -> np.ndarray:
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


class PlumbArchitecturalMeshBuilder:
    """
    Constructs watertight, strictly plumb 3D Spanish Colonial architecture with unshared per-face
    vertices, exact outward normals, material IDs (10..14), and baked 3D ambient occlusion.
      10.0 = Weathered pitch-pine & Spanish cedar timber (balconies, shutters, doors, rafters, carriages)
      11.0 = Coursed coral-limestone ashlar masonry (bastions, quoins, plinths, arches, buttresses, garitas)
      12.0 = Warm Spanish colonial limewashed stucco (encalado walls)
      13.0 = Spanish terracotta barrel roof tiles (tejas curvas)
      14.0 = Deep recessed window panes, wrought-iron rejas, shadowed arcades & cannon embrasures
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
        s = float(np.clip(shade, 0.24, 1.0))
        base = len(self.verts)
        self.verts.extend([p0, p1, p2])
        self.norms.extend([fn, fn, fn])
        self.kinds.extend([float(kind), float(kind), float(kind)])
        self.shades.extend([s, s, s])
        self.faces.append([base, base + 1, base + 2])

    def add_quad(self, a, b, c, d, kind: float, shade: float = 0.88):
        self.add_tri(a, b, c, kind, shade)
        self.add_tri(a, c, d, kind, shade)

    def add_box(
        self,
        x0,
        x1,
        y0,
        y1,
        z0,
        z1,
        kind: float,
        shade: float = 0.86,
        top_inset: float = 0.0,
        cap_top: bool = True,
        cap_bottom: bool = False,
    ):
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

        self.add_quad(p100, p000, p010, p110, kind, shade * 0.96)
        self.add_quad(p101, p100, p110, p111, kind, shade * 1.00)
        self.add_quad(p001, p101, p111, p011, kind, shade * 0.92)
        self.add_quad(p000, p001, p011, p010, kind, shade * 0.90)
        if cap_top:
            self.add_quad(p011, p111, p110, p010, kind, min(1.0, shade * 1.05))
        if cap_bottom:
            self.add_quad(p000, p100, p101, p001, kind, shade * 0.64)

    def add_wall_feature_x(self, x_wall, out_sign, y0, y1, z0, z1, kind: float, shade: float = 0.86, depth: float = 0.020, cap_top: bool = True, cap_bottom: bool = True):
        if out_sign < 0:
            self.add_box(x_wall - depth, x_wall, y0, y1, z0, z1, kind, shade, cap_top=cap_top, cap_bottom=cap_bottom)
        else:
            self.add_box(x_wall, x_wall + depth, y0, y1, z0, z1, kind, shade, cap_top=cap_top, cap_bottom=cap_bottom)

    def add_wall_feature_z(self, z_wall, out_sign, x0, x1, y0, y1, kind: float, shade: float = 0.86, depth: float = 0.020, cap_top: bool = True, cap_bottom: bool = True):
        if out_sign < 0:
            self.add_box(x0, x1, y0, y1, z_wall - depth, z_wall, kind, shade, cap_top=cap_top, cap_bottom=cap_bottom)
        else:
            self.add_box(x0, x1, y0, y1, z_wall, z_wall + depth, kind, shade, cap_top=cap_top, cap_bottom=cap_bottom)

    def add_recessed_window_x(self, x_wall, out_sign, y0, y1, z0, z1, has_shutters: bool = True, has_reja: bool = False):
        """Adds a Spanish colonial window with stone surround, projecting sill, dark reja glazing (Kind 14), and open timber shutters."""
        fw = 0.015
        # Projecting stone lintel & sill + dark recessed opening (Kind 14 shader renders reja/mullion bars)
        self.add_wall_feature_x(x_wall, out_sign, y1, y1 + fw * 1.3, z0 - fw * 1.2, z1 + fw * 1.2, 11.0, 0.92, depth=0.024)
        self.add_wall_feature_x(x_wall, out_sign, y0 - fw * 1.1, y0, z0 - fw * 1.4, z1 + fw * 1.4, 11.0, 0.90, depth=0.028)
        self.add_wall_feature_x(x_wall, out_sign, y0, y1, z0, z1, 14.0, 0.28, depth=0.010, cap_top=False, cap_bottom=False)
        if has_shutters:
            sw = max(0.018, (z1 - z0) * 0.42)
            self.add_wall_feature_x(x_wall, out_sign, y0, y1, z0 - sw, z0, 10.0, 0.72, depth=0.016)
            self.add_wall_feature_x(x_wall, out_sign, y0, y1, z1, z1 + sw, 10.0, 0.70, depth=0.016)

    def add_recessed_window_z(self, z_wall, out_sign, x0, x1, y0, y1, has_shutters: bool = True, has_reja: bool = False):
        fw = 0.015
        self.add_wall_feature_z(z_wall, out_sign, x0 - fw * 1.2, x1 + fw * 1.2, y1, y1 + fw * 1.3, 11.0, 0.92, depth=0.024)
        self.add_wall_feature_z(z_wall, out_sign, x0 - fw * 1.4, x1 + fw * 1.4, y0 - fw * 1.1, y0, 11.0, 0.90, depth=0.028)
        self.add_wall_feature_z(z_wall, out_sign, x0, x1, y0, y1, 14.0, 0.28, depth=0.010, cap_top=False, cap_bottom=False)
        if has_shutters:
            sw = max(0.018, (x1 - x0) * 0.42)
            self.add_wall_feature_z(z_wall, out_sign, x0 - sw, x0, y0, y1, 10.0, 0.72, depth=0.016)
            self.add_wall_feature_z(z_wall, out_sign, x1, x1 + sw, y0, y1, 10.0, 0.70, depth=0.016)

    def add_arched_portal_x(self, x_wall, out_sign, y0, y1, z_center, half_w, is_timber_door: bool = True):
        """Adds a stone-framed semicircular arched portal with jamb pilasters, keystone arch, and timber or dark interior."""
        pw = 0.022
        z0, z1 = z_center - half_w, z_center + half_w
        y_spring = y0 + (y1 - y0) * 0.68
        self.add_wall_feature_x(x_wall, out_sign, y0, y1, z0 - pw, z0, 11.0, 0.87, depth=0.026, cap_top=False, cap_bottom=False)
        self.add_wall_feature_x(x_wall, out_sign, y0, y1, z1, z1 + pw, 11.0, 0.87, depth=0.026, cap_top=False, cap_bottom=False)
        self.add_wall_feature_x(x_wall, out_sign, y_spring, y1 + 0.018, z0 - pw, z1 + pw, 11.0, 0.89, depth=0.022)
        self.add_wall_feature_x(x_wall, out_sign, y1 - 0.015, y1 + 0.028, z_center - 0.018, z_center + 0.018, 11.0, 0.95, depth=0.032)
        self.add_wall_feature_x(x_wall, out_sign, y_spring, y1 - 0.008, z0, z1, 14.0, 0.26, depth=0.010, cap_top=False, cap_bottom=False)
        if is_timber_door:
            self.add_wall_feature_x(x_wall, out_sign, y0, y_spring, z0, z1, 10.0, 0.66, depth=0.010, cap_top=False, cap_bottom=False)
        else:
            self.add_wall_feature_x(x_wall, out_sign, y0, y_spring, z0, z1, 14.0, 0.25, depth=0.008, cap_top=False, cap_bottom=False)

    def add_arched_portal_z(self, z_wall, out_sign, y0, y1, x_center, half_w, is_timber_door: bool = True):
        pw = 0.022
        x0, x1 = x_center - half_w, x_center + half_w
        y_spring = y0 + (y1 - y0) * 0.68
        self.add_wall_feature_z(z_wall, out_sign, x0 - pw, x0, y0, y1, 11.0, 0.87, depth=0.026, cap_top=False, cap_bottom=False)
        self.add_wall_feature_z(z_wall, out_sign, x1, x1 + pw, y0, y1, 11.0, 0.87, depth=0.026, cap_top=False, cap_bottom=False)
        self.add_wall_feature_z(z_wall, out_sign, x0 - pw, x1 + pw, y_spring, y1 + 0.018, 11.0, 0.89, depth=0.022)
        self.add_wall_feature_z(z_wall, out_sign, x_center - 0.018, x_center + 0.018, y1 - 0.015, y1 + 0.028, 11.0, 0.95, depth=0.032)
        self.add_wall_feature_z(z_wall, out_sign, x0, x1, y_spring, y1 - 0.008, 14.0, 0.26, depth=0.010, cap_top=False, cap_bottom=False)
        if is_timber_door:
            self.add_wall_feature_z(z_wall, out_sign, x0, x1, y0, y_spring, 10.0, 0.66, depth=0.010, cap_top=False, cap_bottom=False)
        else:
            self.add_wall_feature_z(z_wall, out_sign, x0, x1, y0, y_spring, 14.0, 0.25, depth=0.008, cap_top=False, cap_bottom=False)

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

    def add_eave_rafter_tails(self, x0, x1, z0, z1, y_eave, overhang: float = 0.038):
        """Adds projecting carved timber rafter tails (canecillos) around the perimeter under the roof eaves."""
        ry0, ry1 = y_eave - 0.028, y_eave - 0.008
        for rz in np.linspace(z0 + 0.05, z1 - 0.05, 5):
            zf = float(rz)
            self.add_box(x0 - overhang * 0.92, x0, ry0, ry1, zf - 0.009, zf + 0.009, 10.0, 0.68, cap_top=False, cap_bottom=True)
            self.add_box(x1, x1 + overhang * 0.92, ry0, ry1, zf - 0.009, zf + 0.009, 10.0, 0.68, cap_top=False, cap_bottom=True)
        for rx in np.linspace(x0 + 0.05, x1 - 0.05, 4):
            xf = float(rx)
            self.add_box(xf - 0.009, xf + 0.009, ry0, ry1, z0 - overhang * 0.92, z0, 10.0, 0.68, cap_top=False, cap_bottom=True)
            self.add_box(xf - 0.009, xf + 0.009, ry0, ry1, z1, z1 + overhang * 0.92, 10.0, 0.68, cap_top=False, cap_bottom=True)

    def add_hipped_roof(self, x0, x1, y_eave, y_peak, z0, z1, overhang: float = 0.038, hip_ratio: float = 0.25, wall_kind: float = 12.0, add_rafters: bool = True):
        """Adds a tiered terracotta barrel-tile roof (kind 13) with stone cornice, timber rafter tails, stepped tile courses, and ridge cap."""
        # Molded stone cornice at top of wall
        self.add_box(x0 - 0.014, x1 + 0.014, y_eave - 0.034, y_eave - 0.014, z0 - 0.014, z1 + 0.014, 11.0, 0.89, cap_bottom=True)
        if add_rafters:
            self.add_eave_rafter_tails(x0, x1, z0, z1, y_eave, overhang)

        rx0, rx1 = x0 - overhang, x1 + overhang
        rz0, rz1 = z0 - overhang, z1 + overhang
        fascia_h = 0.016
        self.add_box(rx0, rx1, y_eave - fascia_h, y_eave, rz0, rz1, 10.0, 0.72, cap_top=True, cap_bottom=True)
        mid_x = 0.5 * (rx0 + rx1)
        span_z = rz1 - rz0
        z_hip0 = rz0 + span_z * hip_ratio
        z_hip1 = rz1 - span_z * hip_ratio

        # 2 stepped terracotta tile tiers for crisp 3D roof course silhouette
        tiers = 2
        for t in range(tiers):
            f0 = t / tiers
            f1 = (t + 1) / tiers
            ty0 = y_eave + (y_peak - y_eave) * f0 + (0.005 if t > 0 else 0.0)
            ty1 = y_eave + (y_peak - y_eave) * f1 + (0.005 if t > 0 else 0.0)

            lx0_b = rx0 + (mid_x - rx0) * f0
            lx1_b = rx1 + (mid_x - rx1) * f0
            lx0_t = rx0 + (mid_x - rx0) * f1
            lx1_t = rx1 + (mid_x - rx1) * f1

            lz0_b = rz0 + (z_hip0 - rz0) * f0 if hip_ratio > 0.02 else rz0
            lz1_b = rz1 + (z_hip1 - rz1) * f0 if hip_ratio > 0.02 else rz1
            lz0_t = rz0 + (z_hip0 - rz0) * f1 if hip_ratio > 0.02 else rz0
            lz1_t = rz1 + (z_hip1 - rz1) * f1 if hip_ratio > 0.02 else rz1

            e00 = [lx0_b, ty0, lz0_b]
            e10 = [lx1_b, ty0, lz0_b]
            e11 = [lx1_b, ty0, lz1_b]
            e01 = [lx0_b, ty0, lz1_b]
            r00 = [lx0_t, ty1, lz0_t]
            r10 = [lx1_t, ty1, lz0_t]
            r11 = [lx1_t, ty1, lz1_t]
            r01 = [lx0_t, ty1, lz1_t]

            t_shade = 0.92 + 0.05 * t
            self.add_quad(e00, e01, r01, r00, 13.0, t_shade * 0.96)
            self.add_quad(e11, e10, r10, r11, 13.0, t_shade * 0.90)
            if hip_ratio > 0.02:
                self.add_quad(e10, e00, r00, r10, 13.0, t_shade * 0.94)
                self.add_quad(e01, e11, r11, r01, 13.0, t_shade * 0.92)

        if hip_ratio <= 0.02:
            self.add_tri([x1, y_eave, z0], [x0, y_eave, z0], [mid_x, y_peak - 0.006, z0], wall_kind, 0.88)
            self.add_tri([x0, y_eave, z1], [x1, y_eave, z1], [mid_x, y_peak - 0.006, z1], wall_kind, 0.86)

        if z_hip1 > z_hip0 + 0.02:
            self.add_box(mid_x - 0.016, mid_x + 0.016, y_peak - 0.004, y_peak + 0.018, z_hip0, z_hip1, 13.0, 0.99, top_inset=0.005)

    def add_cloister_hipped_roof(self, x0, x1, z0, z1, ix0, ix1, iz0, iz1, y_eave, y_peak, overhang: float = 0.040, inner_overhang: float = 0.024):
        """Adds a 4-wing closed-perimeter cloistered hipped terracotta roof (Casa Patio) with cornice, rafter tails, and ridge ring."""
        self.add_box(x0 - 0.014, x1 + 0.014, y_eave - 0.034, y_eave - 0.014, z0 - 0.014, z1 + 0.014, 11.0, 0.89, cap_bottom=True)
        self.add_eave_rafter_tails(x0, x1, z0, z1, y_eave, overhang)

        ox0, ox1 = x0 - overhang, x1 + overhang
        oz0, oz1 = z0 - overhang, z1 + overhang
        cx0, cx1 = ix0 + inner_overhang, ix1 - inner_overhang
        cz0, cz1 = iz0 + inner_overhang, iz1 - inner_overhang

        rx0 = 0.5 * (x0 + ix0)
        rx1 = 0.5 * (x1 + ix1)
        rz0 = 0.5 * (z0 + iz0)
        rz1 = 0.5 * (z1 + iz1)

        fascia_h = 0.018
        self.add_box(ox0, ox1, y_eave - fascia_h, y_eave, oz0, oz0 + 0.025, 10.0, 0.72, cap_bottom=True)
        self.add_box(ox0, ox1, y_eave - fascia_h, y_eave, oz1 - 0.025, oz1, 10.0, 0.72, cap_bottom=True)
        self.add_box(ox0, ox0 + 0.025, y_eave - fascia_h, y_eave, oz0, oz1, 10.0, 0.72, cap_bottom=True)
        self.add_box(ox1 - 0.025, ox1, y_eave - fascia_h, y_eave, oz0, oz1, 10.0, 0.72, cap_bottom=True)
        self.add_box(cx0 - 0.02, cx1 + 0.02, y_eave - fascia_h, y_eave, cz0 - 0.02, cz0, 10.0, 0.70, cap_bottom=True)
        self.add_box(cx0 - 0.02, cx1 + 0.02, y_eave - fascia_h, y_eave, cz1, cz1 + 0.02, 10.0, 0.70, cap_bottom=True)
        self.add_box(cx0 - 0.02, cx0, y_eave - fascia_h, y_eave, cz0, cz1, 10.0, 0.70, cap_bottom=True)
        self.add_box(cx1, cx1 + 0.02, y_eave - fascia_h, y_eave, cz0, cz1, 10.0, 0.70, cap_bottom=True)

        e00, e10, e11, e01 = [ox0, y_eave, oz0], [ox1, y_eave, oz0], [ox1, y_eave, oz1], [ox0, y_eave, oz1]
        r00, r10, r11, r01 = [rx0, y_peak, rz0], [rx1, y_peak, rz0], [rx1, y_peak, rz1], [rx0, y_peak, rz1]
        i00, i10, i11, i01 = [cx0, y_eave, cz0], [cx1, y_eave, cz0], [cx1, y_eave, cz1], [cx0, y_eave, cz1]

        self.add_quad(e00, e01, r01, r00, 13.0, 0.95)
        self.add_quad(e11, e10, r10, r11, 13.0, 0.89)
        self.add_quad(e10, e00, r00, r10, 13.0, 0.93)
        self.add_quad(e01, e11, r11, r01, 13.0, 0.91)

        self.add_quad(i01, i00, r00, r01, 13.0, 0.85)
        self.add_quad(i10, i11, r11, r10, 13.0, 0.91)
        self.add_quad(i00, i10, r10, r00, 13.0, 0.87)
        self.add_quad(i11, i01, r01, r11, 13.0, 0.89)

        rw = 0.016
        self.add_box(rx0 - rw, rx1 + rw, y_peak - 0.004, y_peak + 0.018, rz0 - rw, rz0 + rw, 13.0, 0.98, top_inset=0.004)
        self.add_box(rx0 - rw, rx1 + rw, y_peak - 0.004, y_peak + 0.018, rz1 - rw, rz1 + rw, 13.0, 0.98, top_inset=0.004)
        self.add_box(rx0 - rw, rx0 + rw, y_peak - 0.004, y_peak + 0.018, rz0 + rw, rz1 - rw, 13.0, 0.98, top_inset=0.004)
        self.add_box(rx1 - rw, rx1 + rw, y_peak - 0.004, y_peak + 0.018, rz0 + rw, rz1 - rw, 13.0, 0.98, top_inset=0.004)

    def add_cantilevered_balcony_x(self, x_wall, out_sign, y_floor, y_roof_low, y_roof_high, z0, z1, num_posts: int = 4):
        """Adds a 16th-century Spanish cantilevered hardwood balcony with corbel brackets, balustrade posts, and tiled awning."""
        depth = 0.078
        x_out = x_wall + out_sign * depth
        xa, xb = min(x_wall, x_out), max(x_wall, x_out)
        # Balcony deck beam & floor
        self.add_box(xa, xb, y_floor - 0.012, y_floor + 0.014, z0, z1, 10.0, 0.74, cap_bottom=True)
        # Carved timber corbel brackets under balcony deck
        for cz in np.linspace(z0 + 0.03, z1 - 0.03, num_posts + 1):
            zf = float(cz)
            self.add_box(xa, xb, y_floor - 0.042, y_floor - 0.012, zf - 0.009, zf + 0.009, 10.0, 0.66, cap_bottom=True)
        # Top & bottom handrail + vertical balusters
        rx0, rx1 = (x_out, x_out - out_sign * 0.016)
        rxa, rxb = min(rx0, rx1), max(rx0, rx1)
        self.add_box(rxa, rxb, y_floor + 0.072, y_floor + 0.090, z0, z1, 10.0, 0.78)
        for bz in np.linspace(z0 + 0.01, z1 - 0.01, max(7, num_posts * 3)):
            zf = float(bz)
            self.add_box(rxa + 0.002, rxb - 0.002, y_floor + 0.014, y_floor + 0.072, zf - 0.005, zf + 0.005, 10.0, 0.72)
        # Slender wooden posts supporting the upper pent-roof awning
        for pz in np.linspace(z0 + 0.02, z1 - 0.02, num_posts):
            zf = float(pz)
            self.add_box(rxa, rxb, y_floor + 0.090, y_roof_low, zf - 0.008, zf + 0.008, 10.0, 0.74)
        # Pent-roof terracotta awning
        self.add_pent_roof_x(x_wall, out_sign, y_roof_low, y_roof_high, z0 - 0.01, z1 + 0.01)

    def add_pent_roof_x(self, x_wall, out_sign, y_low, y_high, z0, z1):
        x_out = x_wall + out_sign * 0.095
        self.add_box(min(x_wall, x_out), max(x_wall, x_out), y_low - 0.015, y_low, z0, z1, 10.0, 0.70, cap_bottom=True)
        if out_sign < 0:
            self.add_quad([x_out, y_low, z0], [x_out, y_low, z1], [x_wall, y_high, z1], [x_wall, y_high, z0], 13.0, 0.93)
            self.add_tri([x_wall, y_low, z0], [x_out, y_low, z0], [x_wall, y_high, z0], 10.0, 0.70)
            self.add_tri([x_out, y_low, z1], [x_wall, y_low, z1], [x_wall, y_high, z1], 10.0, 0.70)
        else:
            self.add_quad([x_out, y_low, z1], [x_out, y_low, z0], [x_wall, y_high, z0], [x_wall, y_high, z1], 13.0, 0.90)
            self.add_tri([x_out, y_low, z0], [x_wall, y_low, z0], [x_wall, y_high, z0], 10.0, 0.70)
            self.add_tri([x_wall, y_low, z1], [x_out, y_low, z1], [x_wall, y_high, z1], 10.0, 0.70)

    def finalize(self):
        v = np.asarray(self.verts, dtype=np.float32)
        n = np.asarray(self.norms, dtype=np.float32)
        k = np.asarray(self.kinds, dtype=np.float32)
        s = np.asarray(self.shades, dtype=np.float32)
        f = np.asarray(self.faces, dtype=np.uint32)

        vmin = v.min(axis=0)
        vmax = v.max(axis=0)
        span_xz = max(1e-5, float(max(vmax[0] - vmin[0], vmax[2] - vmin[2])))
        span_y = max(1e-5, float(vmax[1] - vmin[1]))
        v[:, 0] = (v[:, 0] - 0.5 * (vmin[0] + vmax[0])) / span_xz * 0.92
        v[:, 1] = (v[:, 1] - vmin[1]) / span_y
        v[:, 2] = (v[:, 2] - 0.5 * (vmin[2] + vmax[2])) / span_xz * 0.92

        # Bake vertical ground-contact AO + interior cavity AO into `s`
        ground_ao = 0.84 + 0.16 * np.clip(v[:, 1] / 0.25, 0.0, 1.0)
        s = np.clip(s * ground_ao, 0.24, 1.0).astype(np.float32)
        return v, f, n, k, s


def build_plumb_isometric_archetype(asset_id: str, relief_contrast: float = 1.0):
    b = PlumbArchitecturalMeshBuilder(relief_contrast=relief_contrast)

    if asset_id == "stone_sea_bastion":
        # 1. Battered coral-limestone scarp base + corner ashlar quoins + projecting semicircular cordon (bocel)
        b.add_box(-0.46, 0.46, 0.0, 0.38, -0.46, 0.46, 11.0, 0.85, top_inset=0.052)
        b.add_box(-0.422, 0.422, 0.375, 0.412, -0.422, 0.422, 11.0, 0.94, cap_bottom=True)
        # Heavy battered corner quoin buttresses
        for sx in (-1, 1):
            for sz in (-1, 1):
                b.add_box(
                    sx * 0.43 - (0.045 if sx > 0 else 0.015),
                    sx * 0.43 + (0.045 if sx < 0 else 0.015),
                    0.0,
                    0.375,
                    sz * 0.43 - (0.045 if sz > 0 else 0.015),
                    sz * 0.43 + (0.045 if sz < 0 else 0.015),
                    11.0,
                    0.89,
                    top_inset=0.012,
                )
        # 2. Terreplein gun deck & crenellated parapet walls with 8 naval cannons
        b.add_box(-0.40, 0.40, 0.412, 0.44, -0.40, 0.40, 11.0, 0.78)
        wt = 0.055
        for side_z in (-1, 1):
            z0 = -0.40 if side_z < 0 else 0.40 - wt
            z1 = -0.40 + wt if side_z < 0 else 0.40
            b.add_box(-0.40, 0.40, 0.44, 0.50, z0, z1, 11.0, 0.87)
            for m in (-1.5, -0.5, 0.5, 1.5):
                mx = m * 0.19
                b.add_box(mx - 0.055, mx + 0.055, 0.50, 0.565, z0, z1, 11.0, 0.92, top_inset=0.005)
            for c_idx in (-1, 0, 1):
                cx = c_idx * 0.19
                cz = z1 + 0.032 if side_z < 0 else z0 - 0.032
                b.add_box(cx - 0.022, cx + 0.022, 0.44, 0.50, cz - 0.035, cz + 0.035, 10.0, 0.70)
                b.add_box(
                    cx - 0.011,
                    cx + 0.011,
                    0.50,
                    0.528,
                    z0 - 0.045 if side_z < 0 else z0 - 0.01,
                    z1 + 0.01 if side_z < 0 else z1 + 0.045,
                    14.0,
                    0.34,
                    cap_bottom=True,
                )
        for side_x in (-1, 1):
            x0 = -0.40 if side_x < 0 else 0.40 - wt
            x1 = -0.40 + wt if side_x < 0 else 0.40
            b.add_box(x0, x1, 0.44, 0.50, -0.40 + wt, 0.40 - wt, 11.0, 0.86)
            for m in (-1.5, -0.5, 0.5, 1.5):
                mz = m * 0.19
                b.add_box(x0, x1, 0.50, 0.565, mz - 0.055, mz + 0.055, 11.0, 0.91, top_inset=0.005)

        # 3. 4 Corner cylindrical corbeled domed sentry turrets (garitas)
        for sx in (-1, 1):
            for sz in (-1, 1):
                gx, gz = sx * 0.408, sz * 0.408
                b.add_cylinder(gx, gz, 0.29, 0.37, 0.016, 0.048, 8, 11.0, 0.78, cap_top=False)
                b.add_cylinder(gx, gz, 0.37, 0.415, 0.048, 0.068, 8, 11.0, 0.84, cap_top=True)
                b.add_cylinder(gx, gz, 0.415, 0.625, 0.062, 0.062, 8, 11.0, 0.91, cap_top=True)
                b.add_box(gx - 0.067, gx + 0.067, 0.48, 0.57, gz - 0.010, gz + 0.010, 14.0, 0.28)
                b.add_box(gx - 0.010, gx + 0.010, 0.48, 0.57, gz - 0.067, gz + 0.067, 14.0, 0.28)
                b.add_cylinder(gx, gz, 0.625, 0.648, 0.068, 0.068, 8, 11.0, 0.94, cap_top=True)
                b.add_cylinder(gx, gz, 0.648, 0.715, 0.062, 0.030, 8, 11.0, 0.95, cap_top=False)
                b.add_cylinder(gx, gz, 0.715, 0.755, 0.030, 0.008, 8, 11.0, 0.97, cap_top=True)

        # 4. Central 2-story Torre del Homenaje keep with stone quoins, arched portal, windows & hipped tile roof
        kw = 0.215
        b.add_box(-kw - 0.012, kw + 0.012, 0.44, 0.48, -kw - 0.012, kw + 0.012, 11.0, 0.85)
        b.add_box(-kw, kw, 0.48, 0.80, -kw, kw, 12.0, 0.93)
        b.add_box(-kw - 0.010, kw + 0.010, 0.63, 0.65, -kw - 0.010, kw + 0.010, 11.0, 0.89, cap_bottom=True)
        for sx in (-1, 1):
            for sz in (-1, 1):
                for q in range(5):
                    qy0 = 0.48 + q * 0.062
                    q_span = 0.032 if q % 2 == 0 else 0.018
                    b.add_box(
                        sx * kw - (q_span if sx > 0 else 0.008),
                        sx * kw + (q_span if sx < 0 else 0.008),
                        qy0,
                        qy0 + 0.050,
                        sz * kw - (q_span if sz > 0 else 0.008),
                        sz * kw + (q_span if sz < 0 else 0.008),
                        11.0,
                        0.86,
                    )
        b.add_arched_portal_z(-kw, -1, 0.48, 0.61, 0.0, 0.042, is_timber_door=True)
        for wy in (0.51, 0.67):
            for wx in (-0.095, 0.095):
                b.add_recessed_window_z(-kw, -1, wx - 0.022, wx + 0.022, wy, wy + 0.065, has_shutters=True)
                b.add_recessed_window_z(kw, 1, wx - 0.022, wx + 0.022, wy, wy + 0.065, has_shutters=True)
                b.add_recessed_window_x(-kw, -1, wy, wy + 0.065, wx - 0.022, wx + 0.022, has_shutters=True)
                b.add_recessed_window_x(kw, 1, wy, wy + 0.065, wx - 0.022, wx + 0.022, has_shutters=True)
        b.add_hipped_roof(-kw, kw, 0.80, 0.96, -kw, kw, overhang=0.032, hip_ratio=0.45, wall_kind=12.0)
        # Keep masonry chimney & watch turret
        b.add_box(0.08, 0.13, 0.82, 0.99, 0.08, 0.13, 11.0, 0.88)

        # 5. Landward (+Z) arched stone gatehouse portal, portcullis & drawbridge
        b.add_wall_feature_z(0.42, 1, -0.13, 0.13, 0.0, 0.35, 11.0, 0.89, depth=0.055)
        b.add_wall_feature_z(0.42, 1, -0.145, 0.145, 0.33, 0.37, 11.0, 0.93, depth=0.068)
        b.add_arched_portal_z(0.475, 1, 0.0, 0.31, 0.0, 0.072, is_timber_door=True)

    elif asset_id == "casa_de_contratacion":
        # 1. Cut-stone plinth + stepped entry stairs
        hw, hl = 0.34, 0.44
        b.add_box(-hw - 0.02, hw + 0.02, 0.0, 0.08, -hl - 0.02, hl + 0.02, 11.0, 0.84)
        b.add_box(-hw - 0.065, -hw, 0.0, 0.05, -0.11, 0.11, 11.0, 0.88)
        # 2. Main 2-story cream limewashed body (recessed behind ground-floor front loggia)
        loggia_d = 0.095
        b.add_box(-hw + loggia_d, hw, 0.08, 0.74, -hl, hl, 12.0, 0.92)
        b.add_box(-hw, -hw + loggia_d, 0.40, 0.74, -hl, hl, 12.0, 0.93, cap_bottom=True)
        # Stone belt course & alternating corner quoins
        b.add_box(-hw - 0.014, hw + 0.014, 0.385, 0.415, -hl - 0.014, hl + 0.014, 11.0, 0.89, cap_bottom=True)
        for sx in (-1, 1):
            for sz in (-1, 1):
                for q in range(8):
                    qy0 = 0.08 + q * 0.080
                    q_span = 0.042 if q % 2 == 0 else 0.024
                    b.add_box(
                        sx * hw - (q_span if sx > 0 else 0.012),
                        sx * hw + (q_span if sx < 0 else 0.012),
                        qy0,
                        qy0 + 0.064,
                        sz * hl - (q_span if sz > 0 else 0.012),
                        sz * hl + (q_span if sz < 0 else 0.012),
                        11.0,
                        0.85,
                    )
        # 3. 5-Arch stone colonnade loggia along the front (-X) facade
        bays = 5
        bay_span = (2 * hl - 0.08) / bays
        for i in range(bays + 1):
            pz = -hl + 0.04 + i * bay_span
            # Square stone pier with plinth base & moulded capital
            b.add_box(-hw - 0.014, -hw + loggia_d, 0.08, 0.12, pz - 0.028, pz + 0.028, 11.0, 0.85)
            b.add_box(-hw - 0.008, -hw + loggia_d, 0.12, 0.30, pz - 0.022, pz + 0.022, 11.0, 0.89)
            b.add_box(-hw - 0.016, -hw + loggia_d + 0.008, 0.30, 0.325, pz - 0.028, pz + 0.028, 11.0, 0.92, cap_bottom=True)
            if i < bays:
                mz = pz + 0.5 * bay_span
                # Radial arch header & keystone
                b.add_box(-hw - 0.008, -hw + 0.038, 0.32, 0.385, pz + 0.018, pz + bay_span - 0.018, 11.0, 0.90, cap_bottom=True)
                b.add_wall_feature_x(-hw - 0.008, -1, 0.33, 0.39, mz - 0.014, mz + 0.014, 11.0, 0.95, depth=0.016)
                # Deep recessed loggia archway & rear timber portal
                b.add_arched_portal_x(-hw + loggia_d, -1, 0.08, 0.35, mz, 0.042, is_timber_door=(i == 2))
                # 2nd-story piano nobile French doors with stone frame & open timber shutters
                b.add_recessed_window_x(-hw, -1, 0.42, 0.65, mz - 0.032, mz + 0.032, has_shutters=True)

        # 4. Full-length cantilevered 2nd-story timber balcony with corbels, posts & tiled awning
        b.add_cantilevered_balcony_x(-hw, -1, 0.395, 0.63, 0.71, -hl + 0.03, hl - 0.03, num_posts=6)

        # Side gable windows & balconies on -Z and +Z walls
        for sz in (-1, 1):
            z_wall = sz * hl
            for wx in (-0.15, 0.15):
                b.add_recessed_window_z(z_wall, sz, wx - 0.032, wx + 0.032, 0.14, 0.31, has_shutters=True, has_reja=True)
                b.add_recessed_window_z(z_wall, sz, wx - 0.032, wx + 0.032, 0.44, 0.64, has_shutters=True)

        # 5. Rear (+X) facade: 3 arched stone cargo portals & upper shuttered windows
        for rz in (-0.25, 0.0, 0.25):
            b.add_arched_portal_x(hw, 1, 0.08, 0.36, rz, 0.056, is_timber_door=True)
            b.add_recessed_window_x(hw, 1, 0.45, 0.64, rz - 0.034, rz + 0.034, has_shutters=True)

        # 6. Tiered hipped terracotta barrel-tile roof + twin masonry chimneys
        b.add_hipped_roof(-hw, hw, 0.74, 0.96, -hl, hl, overhang=0.045, hip_ratio=0.24, wall_kind=12.0)
        b.add_box(0.12, 0.18, 0.76, 0.98, -0.24, -0.18, 11.0, 0.87)
        b.add_box(0.12, 0.18, 0.76, 0.98, 0.18, 0.24, 11.0, 0.87)

    elif asset_id == "mission_chapel":
        # 1. Basilican Church: high central clerestory nave + flanking lower side aisles with lean-to tile roofs
        hw, hl = 0.21, 0.42
        aisle_w = 0.085
        b.add_box(-hw - aisle_w - 0.015, hw + aisle_w + 0.015, 0.0, 0.05, -hl - 0.015, hl + 0.015, 11.0, 0.84)
        # Central clerestory nave
        b.add_box(-hw, hw, 0.05, 0.50, -hl, hl, 12.0, 0.93)
        # Side aisles (-X and +X) + sloped lean-to terracotta roofs
        for sx in (-1, 1):
            ax0 = sx * hw if sx > 0 else -hw - aisle_w
            ax1 = sx * (hw + aisle_w) if sx > 0 else -hw
            b.add_box(ax0, ax1, 0.05, 0.28, -hl + 0.04, hl - 0.02, 12.0, 0.90)
            b.add_pent_roof_x(sx * hw, sx, 0.28, 0.36, -hl + 0.03, hl - 0.01)

        # 2. 5 Stepped coral-stone exterior buttresses & arched clerestory windows
        for idx in range(5):
            bz = -hl + 0.08 + idx * 0.18
            for sx in (-1, 1):
                b.add_wall_feature_x(sx * (hw + aisle_w), sx, 0.05, 0.27, bz - 0.024, bz + 0.024, 11.0, 0.85, depth=0.038)
                b.add_wall_feature_x(sx * hw, sx, 0.28, 0.48, bz - 0.020, bz + 0.020, 11.0, 0.88, depth=0.028)
            if idx < 4:
                wz = bz + 0.09
                b.add_recessed_window_x(-hw, -1, 0.36, 0.46, wz - 0.022, wz + 0.022, has_shutters=False)
                b.add_recessed_window_x(hw, 1, 0.36, 0.46, wz - 0.022, wz + 0.022, has_shutters=False)
                b.add_recessed_window_x(-(hw + aisle_w), -1, 0.11, 0.23, wz - 0.022, wz + 0.022, has_shutters=False, has_reja=True)
                b.add_recessed_window_x(hw + aisle_w, 1, 0.11, 0.23, wz - 0.022, wz + 0.022, has_shutters=False, has_reja=True)

        # 3. Front (-Z) Plateresque facade: stepped espadaña gable parapet, twin stone pilasters, arched portal & rose window
        b.add_wall_feature_z(-hl, -1, -hw - 0.02, hw + 0.02, 0.05, 0.50, 11.0, 0.89, depth=0.016)
        # Stepped Plateresque frontispiece rising to the gable peak
        b.add_wall_feature_z(-hl, -1, -0.15, 0.15, 0.50, 0.60, 12.0, 0.92, depth=0.018)
        b.add_wall_feature_z(-hl, -1, -0.09, 0.09, 0.60, 0.69, 11.0, 0.90, depth=0.022)
        for px_pil in (-0.12, 0.12):
            b.add_wall_feature_z(-hl - 0.016, -1, px_pil - 0.022, px_pil + 0.022, 0.05, 0.48, 11.0, 0.87, depth=0.026)
        b.add_arched_portal_z(-hl - 0.016, -1, 0.05, 0.33, 0.0, 0.075, is_timber_door=True)
        # Triangular stone pediment above portal
        b.add_wall_feature_z(-hl - 0.016, -1, -0.135, 0.135, 0.33, 0.355, 11.0, 0.93, depth=0.038)
        # Recessed octagonal rose window with stone tracery ring
        b.add_wall_feature_z(-hl - 0.016, -1, -0.052, 0.052, 0.38, 0.48, 11.0, 0.91, depth=0.024)
        b.add_wall_feature_z(-hl - 0.040, -1, -0.034, 0.034, 0.398, 0.462, 14.0, 0.26, depth=0.010)
        b.add_wall_feature_z(-hl - 0.040, -1, -0.005, 0.005, 0.398, 0.462, 11.0, 0.86, depth=0.014)
        b.add_wall_feature_z(-hl - 0.040, -1, -0.034, 0.034, 0.425, 0.435, 11.0, 0.86, depth=0.014)

        # 4. Tiered gabled terracotta barrel-tile roof over the nave
        b.add_hipped_roof(-hw, hw, 0.50, 0.68, -hl, hl, overhang=0.034, hip_ratio=0.0, wall_kind=12.0)

        # 5. Rear (+Z) octagonal stone sanctuary apse with conical terracotta roof
        b.add_cylinder(0.0, hl + 0.02, 0.0, 0.05, 0.185, 0.185, 8, 11.0, 0.83, cap_top=False)
        b.add_cylinder(0.0, hl + 0.02, 0.05, 0.42, 0.175, 0.175, 8, 11.0, 0.87, cap_top=True)
        b.add_cylinder(0.0, hl + 0.02, 0.40, 0.425, 0.188, 0.188, 8, 11.0, 0.91, cap_top=True)
        b.add_cylinder(0.0, hl + 0.02, 0.425, 0.58, 0.195, 0.012, 8, 13.0, 0.94, cap_top=True)

        # 6. 3-Stage Square Stone Bell Tower (Campanario) with corner pilasters, double belfry arches & bronze bells
        tx0, tx1 = hw + 0.01, hw + 0.23
        tz0, tz1 = -hl - 0.03, -hl + 0.19
        tmx, tmz = 0.5 * (tx0 + tx1), 0.5 * (tz0 + tz1)
        # Stage 1: Solid coursed stone tower base with corner pilasters
        b.add_box(tx0, tx1, 0.0, 0.50, tz0, tz1, 11.0, 0.87)
        for sx in (tx0, tx1 - 0.028):
            for sz in (tz0, tz1 - 0.028):
                b.add_box(sx - 0.008, sx + 0.036, 0.0, 0.50, sz - 0.008, sz + 0.036, 11.0, 0.84)
        b.add_box(tx0 - 0.016, tx1 + 0.016, 0.49, 0.52, tz0 - 0.016, tz1 + 0.016, 11.0, 0.93, cap_bottom=True)
        # Stage 2: Lower arched belfry tier with twin arches per face
        b2_x0, b2_x1, b2_z0, b2_z1 = tx0 + 0.010, tx1 - 0.010, tz0 + 0.010, tz1 - 0.010
        b.add_box(b2_x0, b2_x1, 0.52, 0.71, b2_z0, b2_z1, 11.0, 0.90)
        for off in (-0.036, 0.036):
            b.add_arched_portal_z(b2_z0, -1, 0.53, 0.67, tmx + off, 0.022, is_timber_door=False)
            b.add_arched_portal_z(b2_z1, 1, 0.53, 0.67, tmx + off, 0.022, is_timber_door=False)
            b.add_arched_portal_x(b2_x0, -1, 0.53, 0.67, tmz + off, 0.022, is_timber_door=False)
            b.add_arched_portal_x(b2_x1, 1, 0.53, 0.67, tmz + off, 0.022, is_timber_door=False)
        b.add_box(tx0 - 0.008, tx1 + 0.008, 0.70, 0.728, tz0 - 0.008, tz1 + 0.008, 11.0, 0.93, cap_bottom=True)
        # Stage 3: Upper belfry tier + corner stone pinnacles + pyramidal terracotta roof & cross finial
        b3_x0, b3_x1, b3_z0, b3_z1 = tx0 + 0.020, tx1 - 0.020, tz0 + 0.020, tz1 - 0.020
        b.add_box(b3_x0, b3_x1, 0.728, 0.88, b3_z0, b3_z1, 11.0, 0.92)
        b.add_arched_portal_z(b3_z0, -1, 0.74, 0.85, tmx, 0.032, is_timber_door=False)
        b.add_arched_portal_z(b3_z1, 1, 0.74, 0.85, tmx, 0.032, is_timber_door=False)
        b.add_arched_portal_x(b3_x0, -1, 0.74, 0.85, tmz, 0.032, is_timber_door=False)
        b.add_arched_portal_x(b3_x1, 1, 0.74, 0.85, tmz, 0.032, is_timber_door=False)
        for px_pin in (b3_x0, b3_x1):
            for pz_pin in (b3_z0, b3_z1):
                b.add_box(px_pin - 0.012, px_pin + 0.012, 0.88, 0.93, pz_pin - 0.012, pz_pin + 0.012, 11.0, 0.94, top_inset=0.008)
        b.add_hipped_roof(b3_x0, b3_x1, 0.88, 0.98, b3_z0, b3_z1, overhang=0.022, hip_ratio=0.49, wall_kind=11.0, add_rafters=False)
        b.add_box(tmx - 0.006, tmx + 0.006, 0.97, 1.02, tmz - 0.006, tmz + 0.006, 14.0, 0.38)
        b.add_box(tmx - 0.022, tmx + 0.022, 0.995, 1.006, tmz - 0.005, tmz + 0.005, 14.0, 0.38)

        # Align nave along Z/X to match runtime footprint length along Z
        b.verts = [[v[2], v[1], v[0]] for v in b.verts]
        b.norms = [[n[2], n[1], n[0]] for n in b.norms]
        b.faces = [(f[0], f[2], f[1]) for f in b.faces]

    else:
        # colonial_town_block — 4-Wing Closed-Perimeter Casa Patio with central stone fountain, cloister arches, rejas & balconies
        hw, hl = 0.39, 0.42
        ix, iz = 0.14, 0.16
        b.add_box(-hw - 0.015, hw + 0.015, 0.0, 0.06, -hl - 0.015, hl + 0.015, 11.0, 0.84)
        # 4 full-height two-story masonry wings surrounding the central patio lightwell [-ix..ix, -iz..iz]
        b.add_box(-hw, -ix, 0.06, 0.70, -hl, hl, 12.0, 0.92)
        b.add_box(ix, hw, 0.06, 0.70, -hl, hl, 12.0, 0.90)
        b.add_box(-ix, ix, 0.06, 0.70, -hl, -iz, 12.0, 0.91)
        b.add_box(-ix, ix, 0.06, 0.70, iz, hl, 12.0, 0.89)
        # Recessed central courtyard stone floor + central octagonal stone fountain basin & pedestal
        b.add_box(-ix, ix, 0.06, 0.09, -iz, iz, 11.0, 0.76)
        b.add_cylinder(0.0, 0.0, 0.09, 0.14, 0.052, 0.055, 8, 11.0, 0.88, cap_top=True)
        b.add_cylinder(0.0, 0.0, 0.14, 0.22, 0.016, 0.012, 8, 11.0, 0.92, cap_top=True)
        # Inward-facing courtyard cloister arches & 2nd-story timber gallery balustrades
        for cz in (-0.09, 0.0, 0.09):
            b.add_arched_portal_x(-ix, 1, 0.09, 0.34, cz, 0.028, is_timber_door=False)
            b.add_arched_portal_x(ix, -1, 0.09, 0.34, cz, 0.028, is_timber_door=False)
            b.add_recessed_window_x(-ix, 1, 0.44, 0.62, cz - 0.022, cz + 0.022, has_shutters=False)
            b.add_recessed_window_x(ix, -1, 0.44, 0.62, cz - 0.022, cz + 0.022, has_shutters=False)
        for cx in (-0.08, 0.0, 0.08):
            b.add_arched_portal_z(-iz, 1, 0.09, 0.34, cx, 0.028, is_timber_door=False)
            b.add_arched_portal_z(iz, -1, 0.09, 0.34, cx, 0.028, is_timber_door=False)
            b.add_recessed_window_z(-iz, 1, cx - 0.022, cx + 0.022, 0.44, 0.62, has_shutters=False)
            b.add_recessed_window_z(iz, -1, cx - 0.022, cx + 0.022, 0.44, 0.62, has_shutters=False)
        b.add_box(-ix, ix, 0.36, 0.44, -iz, -iz + 0.022, 10.0, 0.74)
        b.add_box(-ix, ix, 0.36, 0.44, iz - 0.022, iz, 10.0, 0.74)
        b.add_box(-ix, -ix + 0.022, 0.36, 0.44, -iz, iz, 10.0, 0.74)
        b.add_box(ix - 0.022, ix, 0.36, 0.44, -iz, iz, 10.0, 0.74)

        # Stone belt course & alternating coral-stone corner quoins on all 4 exterior corners
        b.add_box(-hw - 0.012, hw + 0.012, 0.36, 0.388, -hl - 0.012, hl + 0.012, 11.0, 0.88, cap_bottom=True)
        for sx in (-1, 1):
            for sz in (-1, 1):
                for q in range(7):
                    qy0 = 0.06 + q * 0.090
                    q_span = 0.038 if q % 2 == 0 else 0.022
                    b.add_box(
                        sx * hw - (q_span if sx > 0 else 0.010),
                        sx * hw + (q_span if sx < 0 else 0.010),
                        qy0,
                        qy0 + 0.072,
                        sz * hl - (q_span if sz > 0 else 0.010),
                        sz * hl + (q_span if sz < 0 else 0.010),
                        11.0,
                        0.85,
                    )
        # Front (-X) & Rear (+X) arched zaguán carriage portals + flanking ground-floor reja windows
        b.add_arched_portal_x(-hw, -1, 0.06, 0.34, 0.0, 0.062, is_timber_door=True)
        for az in (-0.22, 0.22):
            b.add_recessed_window_x(-hw, -1, 0.11, 0.30, az - 0.036, az + 0.036, has_shutters=True, has_reja=True)
            b.add_recessed_window_x(hw, 1, 0.11, 0.30, az - 0.036, az + 0.036, has_shutters=True, has_reja=True)
        b.add_arched_portal_x(hw, 1, 0.06, 0.34, 0.0, 0.058, is_timber_door=True)

        # Upper-floor shuttered balcony doors & side windows with wrought-iron rejas
        for wz in (-0.26, -0.09, 0.09, 0.26):
            b.add_recessed_window_x(-hw, -1, 0.42, 0.62, wz - 0.032, wz + 0.032, has_shutters=True)
            b.add_recessed_window_x(hw, 1, 0.42, 0.62, wz - 0.032, wz + 0.032, has_shutters=True)
        for wx in (-0.24, -0.08, 0.08, 0.24):
            b.add_recessed_window_z(-hl, -1, wx - 0.032, wx + 0.032, 0.42, 0.62, has_shutters=True)
            b.add_recessed_window_z(-hl, -1, wx - 0.032, wx + 0.032, 0.11, 0.30, has_shutters=True, has_reja=True)
            b.add_recessed_window_z(hl, 1, wx - 0.032, wx + 0.032, 0.42, 0.62, has_shutters=True)
            b.add_recessed_window_z(hl, 1, wx - 0.032, wx + 0.032, 0.11, 0.30, has_shutters=True, has_reja=True)

        # Cantilevered 2nd-story hardwood balconies with corbels, posts & tiled awnings on Front (-X) & Back (+X)
        for sx in (-1, 1):
            b.add_cantilevered_balcony_x(sx * hw, sx, 0.375, 0.60, 0.68, -0.22, 0.22, num_posts=4)

        # 4-Wing Closed-Perimeter Cloistered Hipped Terracotta Roof + twin chimneys
        b.add_cloister_hipped_roof(-hw, hw, -hl, hl, -ix, ix, -iz, iz, 0.70, 0.94, overhang=0.042, inner_overhang=0.022)
        b.add_box(-0.29, -0.23, 0.74, 0.96, -0.29, -0.23, 11.0, 0.87)
        b.add_box(0.23, 0.29, 0.74, 0.96, 0.23, 0.29, 11.0, 0.87)

    return b.finalize()


def prepare_atlas_tile_and_bbox(seg_rgba: Image.Image, tile_w: int = 256, tile_h: int = 512):
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


def project_camera_coords(verts: np.ndarray, yaw_deg: float, pitch_deg: float = 28.0):
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

    cam_dir = np.array([-sy * cp, sp, cy * cp], dtype=np.float32)
    cam_dir /= max(1e-6, float(np.linalg.norm(cam_dir)))
    return u_cam, v_cam, depth_cam, cam_dir


def evaluate_material_color(verts: np.ndarray, kinds: np.ndarray, shades: np.ndarray) -> np.ndarray:
    """
    Computes rich procedural sRGB colors matching js/wgsl/terrain.js (Kind 10..14) so GLB exports
    and Z-buffer renders have zero cross-part UV smearing and crisp stone/stucco/tile/timber detail.
    """
    out = np.zeros((len(verts), 3), dtype=np.uint8)
    for i in range(len(verts)):
        vx, vy, vz = float(verts[i, 0]), float(verts[i, 1]), float(verts[i, 2])
        k = int(round(float(kinds[i])))
        sh = float(shades[i])
        grain = 0.04 * math.sin(vx * 38.0 + vz * 41.0 + vy * 29.0)
        if k == 10:
            # Weathered Spanish cedar & oak timber
            plank = 0.05 * math.sin(vy * 55.0 + vx * 18.0)
            rgb = np.array([0.42, 0.28, 0.17]) * sh * (1.0 + grain + plank)
        elif k == 11:
            # Coursed coral-limestone ashlar masonry
            cy_mod = (vy * 22.0) % 1.0
            cx_mod = ((vx + vz) * 14.0 + math.floor(vy * 22.0) * 0.5) % 1.0
            mortar = 0.88 if (cy_mod < 0.12 or cx_mod < 0.09) else 1.04
            rgb = np.array([0.66, 0.62, 0.54]) * sh * mortar * (1.0 + grain)
        elif k == 12:
            # Warm cream/ochre Spanish colonial limewashed stucco
            damp = min(1.0, max(0.0, (vy - 0.05) / 0.28))
            base = np.array([0.74, 0.67, 0.55]) * (1.0 - damp) + np.array([0.90, 0.84, 0.72]) * damp
            rgb = base * sh * (1.0 + grain * 0.6)
        elif k == 13:
            # Spanish terracotta barrel roof tiles (tejas curvas)
            flute = 0.09 * math.sin((vx * 48.0 + vz * 48.0))
            course = 0.92 if ((vy * 28.0) % 1.0) < 0.16 else 1.03
            rgb = np.array([0.74, 0.34, 0.20]) * sh * course * (1.0 + flute + grain * 0.7)
        else:
            # Deep recessed arcades, portals & wrought-iron reja windows
            rgb = np.array([0.16, 0.13, 0.11]) * sh
        out[i] = np.clip(rgb * 255.0, 0, 255).astype(np.uint8)
    return out


def render_zbuffer_architectural_isometric(
    verts: np.ndarray,
    faces: np.ndarray,
    normals: np.ndarray,
    kinds: np.ndarray,
    shades: np.ndarray,
    yaw_deg: float,
    pitch_deg: float = 24.0,
    res: int = 384,
) -> np.ndarray:
    """
    Per-pixel Z-buffered orthographic rasterizer evaluating the exact per-part 1550 architectural
    materials (Kind 10..14: coursed coral-limestone ashlar, cream limewashed stucco, fluted terracotta
    barrel roof tiles, weathered cedar timber, and recessed portals/rejas) + directional sun & sky lighting.
    """
    u_cam, v_cam, z_cam, _ = project_camera_coords(verts, yaw_deg, pitch_deg)
    scale = res * 0.68
    px = u_cam * scale + (res * 0.5)
    py = -v_cam * scale + (res * 0.52)

    img = np.full((res, res, 3), [12 / 255.0, 20 / 255.0, 28 / 255.0], dtype=np.float32)
    zbuf = np.full((res, res), -1e9, dtype=np.float32)

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

        vx = w0[vis] * verts[i0, 0] + w1[vis] * verts[i1, 0] + w2[vis] * verts[i2, 0]
        vy = w0[vis] * verts[i0, 1] + w1[vis] * verts[i1, 1] + w2[vis] * verts[i2, 1]
        vz = w0[vis] * verts[i0, 2] + w1[vis] * verts[i1, 2] + w2[vis] * verts[i2, 2]
        sh = w0[vis] * shades[i0] + w1[vis] * shades[i1] + w2[vis] * shades[i2]
        k = int(round(float(kinds[i0])))

        grain = 0.04 * np.sin(vx * 42.0 + vz * 45.0 + vy * 31.0)
        if k == 10:
            plank = 0.06 * np.sin(vy * 64.0 + vx * 22.0)
            base_col = np.stack([0.42 + grain + plank, 0.27 + (grain + plank) * 0.7, 0.16 + (grain + plank) * 0.4], axis=-1)
        elif k == 11:
            cy_mod = np.mod(vy * 24.0, 1.0)
            cx_mod = np.mod((vx + vz) * 16.0 + np.floor(vy * 24.0) * 0.5, 1.0)
            mortar = np.where((cy_mod < 0.12) | (cx_mod < 0.09), 0.84, 1.03)
            block_var = 0.04 * np.sin(np.floor(vy * 24.0) * 7.1 + np.floor((vx + vz) * 16.0) * 13.7)
            base_col = np.stack([0.65 + block_var, 0.61 + block_var, 0.52 + block_var], axis=-1) * mortar[:, None]
        elif k == 12:
            damp = np.clip((vy - 0.05) / 0.28, 0.0, 1.0)
            r_c = 0.74 * (1.0 - damp) + 0.91 * damp + grain * 0.5
            g_c = 0.67 * (1.0 - damp) + 0.85 * damp + grain * 0.5
            b_c = 0.55 * (1.0 - damp) + 0.73 * damp + grain * 0.4
            base_col = np.stack([r_c, g_c, b_c], axis=-1)
        elif k == 13:
            flute = 0.09 * np.sin(vx * 58.0 + vz * 58.0)
            course = np.where(np.mod(vy * 32.0, 1.0) < 0.16, 0.88, 1.04)
            base_col = np.stack([0.75 + flute, 0.35 + flute * 0.5, 0.20 + flute * 0.3], axis=-1) * course[:, None]
        else:
            base_col = np.full((np.sum(vis), 3), [0.14, 0.11, 0.09], dtype=np.float32)

        fn = normals[i0]
        sun_dot = max(0.0, float(np.dot(fn, sun_dir)))
        hemi = 0.66 + 0.34 * max(-1.0, min(1.0, float(fn[1])))
        lit = min(1.16, 0.68 * hemi + 0.42 * sun_dot)

        edge_dist = np.minimum(np.minimum(w0[vis], w1[vis]), w2[vis])
        edge_factor = np.where(edge_dist < 0.018, 0.93, 1.0)

        sub_img = img[min_y : max_y + 1, min_x : max_x + 1]
        sub_img[vis] = base_col * (sh[:, None] * lit * edge_factor[:, None])

    return (np.clip(img, 0.0, 1.0) * 255.0).astype(np.uint8)


def main():
    parser = argparse.ArgumentParser(description="Build 1550 Spanish Main High-Detail Plumb 3D Building Assets")
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
        print(f"\n=== Building High-Detail Plumb 3D Archetype: {name} ({asset_id}) ===")

        front_iso_im = Image.open(front_iso_path).convert("RGB")
        back_iso_im = Image.open(back_iso_path).convert("RGB")
        seg_front_im = segment_studio_background(front_iso_im)
        seg_back_im = segment_studio_background(back_iso_im)

        asset_sub = os.path.join(args.out_dir, asset_id)
        os.makedirs(asset_sub, exist_ok=True)
        seg_front_im.save(os.path.join(asset_sub, "iso_front_rgba.png"))
        seg_back_im.save(os.path.join(asset_sub, "iso_back_rgba.png"))
        seg_front_im.save(os.path.join(asset_sub, "iso_rgba.png"))

        front_tile_rgb, front_bbox, mask_front = prepare_atlas_tile_and_bbox(seg_front_im, tile_w=tile_w, tile_h=tile_h)
        back_tile_rgb, back_bbox, mask_back = prepare_atlas_tile_and_bbox(seg_back_im, tile_w=tile_w, tile_h=tile_h)
        atlas_rgb[0:tile_h, row * tile_w : (row + 1) * tile_w] = front_tile_rgb
        atlas_rgb[tile_h : tile_h * 2, row * tile_w : (row + 1) * tile_w] = back_tile_rgb

        depth_front_out = depth_pipe(seg_front_im.convert("RGB"))["depth"]
        d_front_norm = denoise_photorealistic_depth(depth_front_out, mask_front, size=256)
        gy_f, gx_f = np.gradient(d_front_norm)

        depth_back_out = depth_pipe(seg_back_im.convert("RGB"))["depth"]
        d_back_norm = denoise_photorealistic_depth(depth_back_out, mask_back, size=256)
        gy_b, gx_b = np.gradient(d_back_norm)

        relief_contrast = float(np.clip(1.0 + (np.std(gx_f) + np.std(gx_b)), 0.95, 1.15))

        verts, faces, normals, kind, shade = build_plumb_isometric_archetype(asset_id, relief_contrast=relief_contrast)
        vert_rgb = evaluate_material_color(verts, kind, shade)

        # Export clean, plumb GLB file with crisp per-part architectural colors
        glb_path = os.path.join(args.out_dir, f"{asset_id}.glb")
        v_colors = np.column_stack([vert_rgb, np.full((len(verts), 1), 255, dtype=np.uint8)])
        mesh_obj = trimesh.Trimesh(vertices=verts, faces=faces, vertex_normals=normals, vertex_colors=v_colors, process=False)
        mesh_obj.export(glb_path)

        # Pack 8-float vertex buffer [lx, ly, lz, nx, ny, nz, kind (10..14), shade (3D AO)] + uint16 index buffer
        v_pack = np.column_stack([verts, normals, kind[:, None], shade[:, None]]).astype("<f4")
        i_pack = faces.reshape(-1).astype("<u2")
        lrm_templates.append((asset_id, v_pack, i_pack))

        unique_k, counts_k = np.unique(kind.astype(int), return_counts=True)
        mat_stats = {int(k): round(float(c) / len(kind) * 100.0, 1) for k, c in zip(unique_k, counts_k)}
        plumb_wall_pct = float(np.mean(np.isclose(normals[:, 1], 0.0, atol=0.18) | (normals[:, 1] > 0.35)) * 100.0)
        print(
            f"  -> {asset_id}: {len(faces):,} high-detail plumb triangles ({len(verts):,} unshared verts), "
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
                kind,
                shade,
                front_yaw_deg,
                back_yaw_deg,
            )
        )

    atlas_pil = Image.fromarray(atlas_rgb, mode="RGB")
    photo_atlas_jpg = os.path.join(args.out_dir, "buildings-1550-photo-atlas.jpg")
    photo_atlas_png = os.path.join(args.out_dir, "buildings-1550-photo-atlas.png")
    atlas_pil.save(photo_atlas_jpg, quality=92, optimize=True)
    atlas_pil.save(photo_atlas_png)

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
        kind,
        shade,
        front_yaw_deg,
        back_yaw_deg,
    ) in staged_rows:
        bg_front = Image.new("RGBA", seg_front_im.size, (18, 30, 42, 255))
        bg_front.paste(seg_front_im, (0, 0), seg_front_im)
        ax1 = fig.add_subplot(len(items), 5, row * 5 + 1)
        ax1.imshow(bg_front)
        ax1.set_title(f"{name}\n1. Front-Oblique Telephoto Reference", color="#f5bf77", fontsize=10, fontweight="bold")
        ax1.axis("off")

        bg_back = Image.new("RGBA", seg_back_im.size, (18, 30, 42, 255))
        bg_back.paste(seg_back_im, (0, 0), seg_back_im)
        ax2 = fig.add_subplot(len(items), 5, row * 5 + 2)
        ax2.imshow(bg_back)
        ax2.set_title("2. Rear-Oblique Telephoto Reference\n(Opposite 180° Elevation)", color="#f5bf77", fontsize=10, fontweight="bold")
        ax2.axis("off")

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

        front_3d_img = render_zbuffer_architectural_isometric(
            verts, faces, normals, kind, shade, yaw_deg=front_yaw_deg - 14.0, pitch_deg=23.0, res=384
        )
        ax4 = fig.add_subplot(len(items), 5, row * 5 + 4)
        ax4.imshow(front_3d_img)
        ax4.set_axis_off()
        ax4.set_title(
            f"4. High-Detail 3D Mesh (Front)\n({len(faces):,} Plumb Tris · Per-Part Materials)",
            color="#7ae582",
            fontsize=10,
            fontweight="bold",
        )

        back_3d_img = render_zbuffer_architectural_isometric(
            verts, faces, normals, kind, shade, yaw_deg=back_yaw_deg + 14.0, pitch_deg=25.0, res=384
        )
        ax5 = fig.add_subplot(len(items), 5, row * 5 + 5)
        ax5.imshow(back_3d_img)
        ax5.set_axis_off()
        ax5.set_title(
            "5. High-Detail 3D Mesh (Rear)\n(Zero UV Smearing · 3D Arches/Shutters/Tiles)",
            color="#7ae582",
            fontsize=10,
            fontweight="bold",
        )

    plt.suptitle(
        "1550 Spanish Main — High-Detail Plumb 3D Architecture (Coursed Ashlar · Limewash · Tiered Tejas · Rejas & Shutters)",
        color="#f5bf77",
        fontsize=14,
        fontweight="bold",
        y=0.992,
    )
    plt.tight_layout(rect=[0, 0, 1, 0.982])
    atlas_out = os.path.join(args.out_dir, "building_3d_pipeline_atlas.png")
    plt.savefig(atlas_out, dpi=140, facecolor=fig.get_facecolor())
    print(f"\nSaved High-Detail 3D Building Pipeline Atlas to {atlas_out}")

    with open(os.path.join(args.out_dir, "building_assets_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

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
    print(f"Saved WebGPU High-Detail 3D Building Bundle to {lrm_bin_path} ({os.path.getsize(lrm_bin_path)/1024:.1f} KB)")


if __name__ == "__main__":
    main()
