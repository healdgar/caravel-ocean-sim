#!/usr/bin/env python3
"""
1550 Spanish Main — Multi-View 3D Building Asset Pipeline
=========================================================
Converts 4-view orthographic turnaround sheets (Front, Back, Left, Right) into:
1. Clean alpha-segmented turnaround views (mv_front.png, mv_back.png, mv_left.png, mv_right.png)
2. Watertight 3D meshes (.glb) via:
   - Primary LRM: Tencent Hunyuan3D-2mv (multi-view controlled DiT flow-matching LRM)
   - Quadric Mesh Simplification (fast-simplification) to game-ready 3,600-triangle meshes
   - Outward normal orientation + nearest-foreground EDT inpainting + Triplane RGB/Material projection (Kinds 10..14)
3. Exports game-ready decimated .glb files, WebGPU binary mesh bundle (buildings_1550_lrm.bin),
   and a 4-stage visual diagnostic atlas (building_3d_pipeline_atlas.png).
"""

import argparse
import json
import math
import os
import shutil
import struct
import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, binary_erosion, binary_fill_holes, distance_transform_edt, gaussian_filter
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


def split_turnaround_2x2(sheet_img: Image.Image):
    """Splits a 1:1 2x2 turnaround sheet into Front (TL), Back (TR), Left (BL), Right (BR)."""
    w, h = sheet_img.size
    hw, hh = w // 2, h // 2
    return {
        "front": sheet_img.crop((0, 0, hw, hh)),
        "back": sheet_img.crop((hw, 0, w, hh)),
        "left": sheet_img.crop((0, hh, hw, h)),
        "right": sheet_img.crop((hw, hh, w, h)),
    }


def segment_studio_background(view_img: Image.Image, pad_ratio: float = 0.08) -> Image.Image:
    """
    Segments a studio-rendered orthographic turnaround view from its neutral gray background,
    removes border/grid artifacts, and centers the object consistently inside a square RGBA frame.
    """
    arr = np.asarray(view_img.convert("RGB"), dtype=np.float32)
    h, w, _ = arr.shape

    border_pixels = np.concatenate(
        [
            arr[:10, :, :].reshape(-1, 3),
            arr[-10:, :, :].reshape(-1, 3),
            arr[:, :10, :].reshape(-1, 3),
            arr[:, -10:, :].reshape(-1, 3),
        ],
        axis=0,
    )
    bg_median = np.median(border_pixels, axis=0)

    color_dist = np.linalg.norm(arr - bg_median[None, None, :], axis=-1)
    chroma = np.max(arr, axis=-1) - np.min(arr, axis=-1)
    fg_score = color_dist + chroma * 0.65

    mask = fg_score > 22.0
    mask[:4, :] = False
    mask[-4:, :] = False
    mask[:, :4] = False
    mask[:, -4:] = False

    mask = binary_fill_holes(mask)
    mask = binary_erosion(mask, iterations=1)
    mask = binary_dilation(mask, iterations=1)
    mask = binary_fill_holes(mask)

    alpha = (gaussian_filter(mask.astype(np.float32), sigma=0.7) * 255.0).clip(0, 255).astype(np.uint8)
    alpha[mask] = np.maximum(alpha[mask], 235)
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

    rgba = np.dstack([arr.astype(np.uint8), alpha])
    return Image.fromarray(rgba, mode="RGBA")


def inpaint_foreground_rgb(rgba_im: Image.Image, tex_res: int = 256) -> np.ndarray:
    """
    Resizes an RGBA view to tex_res x tex_res and dilates foreground RGB colors outward into
    transparent background pixels via Euclidean Distance Transform so triplane lookups never sample gray background.
    """
    arr = np.asarray(rgba_im.resize((tex_res, tex_res), Image.Resampling.BILINEAR), dtype=np.float32)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]
    fg_mask = alpha > 140.0
    # Eroded interior mask avoids 1px edge halo
    fg_inner = binary_erosion(fg_mask, iterations=2)
    if np.any(fg_inner):
        indices = distance_transform_edt(~fg_inner, return_distances=False, return_indices=True)
        rgb = rgb[indices[0], indices[1]]
    return rgb


def classify_architectural_material(rgb: np.ndarray, normal_y: np.ndarray, vert_y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Maps triplane-projected RGB colors + outward surface normal to Waterworld's 5 architectural material kinds:
      10 = Weathered dark timber (balconies, beams, doors, piers)
      11 = Coursed coral-limestone ashlar masonry (bastion walls, quoins, plinths, arches)
      12 = Warm Spanish colonial limewashed stucco (nave & customhouse walls)
      13 = Spanish terracotta barrel roof tiles (tejas)
      14 = Deep recessed colonial arcades, embrasures & window shutters
    """
    r, g, b = rgb[:, 0] / 255.0, rgb[:, 1] / 255.0, rgb[:, 2] / 255.0
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    red_excess = r - 0.52 * g - 0.48 * b

    kind = np.full(len(r), 12.0, dtype=np.float32)

    # Terracotta roof tiles: reddish-orange color or upper-facing sloped roof planes above mid-height
    is_terracotta = ((red_excess > 0.085) & (r > 0.32) & (vert_y > 0.28)) | ((normal_y > 0.42) & (vert_y > 0.48))
    kind[is_terracotta] = 13.0

    # Deep recessed colonial arcades, cannon embrasures & window openings
    is_recess = (~is_terracotta) & (luma < 0.22)
    kind[is_recess] = 14.0

    # Weathered dark timber: balconies, shutters, rafters, heavy studded doors
    is_timber = (~is_terracotta) & (~is_recess) & (luma >= 0.22) & (luma < 0.44) & (r > b * 1.15)
    kind[is_timber] = 10.0

    # Coral-limestone ashlar masonry: stone bastion walls, plinths, buttresses, quoins
    is_stone = (~is_terracotta) & (~is_recess) & (~is_timber) & ((luma < 0.65) | (vert_y < 0.14))
    kind[is_stone] = 11.0

    shade = np.clip(0.62 + luma * 0.42, 0.34, 1.0).astype(np.float32)
    return kind, shade


def project_triplane_materials_onto_mesh(
    verts: np.ndarray,
    faces: np.ndarray,
    views_rgba: dict[str, Image.Image],
    tex_res: int = 256,
):
    """
    Normalizes a 3D mesh into [-0.5, 0.5] x [0, 1.0] x [-0.5, 0.5], guarantees outward-pointing
    counter-clockwise face winding, and projects the 4 inpainted orthographic views onto the mesh.
    """
    vmin = verts.min(axis=0)
    vmax = verts.max(axis=0)
    span = np.maximum(1e-5, vmax - vmin)
    horiz_span = max(span[0], span[2])
    v_norm = np.empty_like(verts, dtype=np.float32)
    v_norm[:, 0] = (verts[:, 0] - (vmin[0] + vmax[0]) * 0.5) / horiz_span
    v_norm[:, 1] = (verts[:, 1] - vmin[1]) / span[1]
    v_norm[:, 2] = (verts[:, 2] - (vmin[2] + vmax[2]) * 0.5) / horiz_span

    # Check if face normals point outward from mesh centroid; flip winding if inward
    v0 = v_norm[faces[:, 0]]
    v1 = v_norm[faces[:, 1]]
    v2 = v_norm[faces[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    tri_centers = (v0 + v1 + v2) / 3.0
    centroid = v_norm.mean(axis=0, keepdims=True)
    outward_score = np.mean(np.sum(fn * (tri_centers - centroid), axis=-1))
    if outward_score < 0:
        faces = faces[:, [0, 2, 1]]
        fn = -fn

    fn_len = np.linalg.norm(fn, axis=-1, keepdims=True)
    fn = fn / np.maximum(1e-6, fn_len)

    vn = np.zeros_like(v_norm)
    np.add.at(vn, faces[:, 0], fn)
    np.add.at(vn, faces[:, 1], fn)
    np.add.at(vn, faces[:, 2], fn)
    vn_len = np.linalg.norm(vn, axis=-1, keepdims=True)
    vn = (vn / np.maximum(1e-6, vn_len)).astype(np.float32)

    rgbs = {name: inpaint_foreground_rgb(im, tex_res=tex_res) for name, im in views_rgba.items()}

    ux = (v_norm[:, 0] - v_norm[:, 0].min()) / max(1e-5, v_norm[:, 0].max() - v_norm[:, 0].min())
    uy = (v_norm[:, 1] - v_norm[:, 1].min()) / max(1e-5, v_norm[:, 1].max() - v_norm[:, 1].min())
    uz = (v_norm[:, 2] - v_norm[:, 2].min()) / max(1e-5, v_norm[:, 2].max() - v_norm[:, 2].min())

    ix = np.clip(np.round(ux * (tex_res - 1)).astype(np.int32), 0, tex_res - 1)
    iy = np.clip(np.round((1.0 - uy) * (tex_res - 1)).astype(np.int32), 0, tex_res - 1)
    iz = np.clip(np.round(uz * (tex_res - 1)).astype(np.int32), 0, tex_res - 1)

    c_front = rgbs["front"][iy, ix]
    c_back = rgbs["back"][iy, tex_res - 1 - ix]
    c_left = rgbs["left"][iy, iz]
    c_right = rgbs["right"][iy, tex_res - 1 - iz]

    wf = (np.maximum(0.08, vn[:, 2]) ** 2)[:, None]
    wb = (np.maximum(0.08, -vn[:, 2]) ** 2)[:, None]
    wl = (np.maximum(0.08, -vn[:, 0]) ** 2)[:, None]
    wr = (np.maximum(0.08, vn[:, 0]) ** 2)[:, None]
    v_rgb = (wf * c_front + wb * c_back + wl * c_left + wr * c_right) / (wf + wb + wl + wr)

    kind, shade = classify_architectural_material(v_rgb, vn[:, 1], v_norm[:, 1])
    return v_norm, faces.astype(np.uint32), vn, v_rgb.astype(np.uint8), kind, shade


def load_and_decimate_hunyuan_glb(glb_path: str, target_faces: int = 3600):
    """Loads a Hunyuan3D-2mv GLB mesh, removes duplicate faces, and simplifies via quadric error metrics."""
    import trimesh
    import fast_simplification

    scene = trimesh.load(glb_path)
    geom = list(scene.geometry.values())[0] if hasattr(scene, "geometry") else scene
    f_raw = np.asarray(geom.faces, dtype=np.int32)
    v_raw = np.asarray(geom.vertices, dtype=np.float32)

    f_sorted = np.sort(f_raw, axis=1)
    _, uniq_idx = np.unique(f_sorted, axis=0, return_index=True)
    f_clean = f_raw[np.sort(uniq_idx)]
    non_deg = (f_clean[:, 0] != f_clean[:, 1]) & (f_clean[:, 1] != f_clean[:, 2]) & (f_clean[:, 0] != f_clean[:, 2])
    f_clean = f_clean[non_deg].astype(np.int32)

    v_dec, f_dec = fast_simplification.simplify(v_raw, f_clean, target_count=target_faces, agg=7)
    return v_dec.astype(np.float32), f_dec.astype(np.uint32), len(f_clean)


def try_hunyuan3d_2mv(views_paths: dict[str, str], out_glb_path: str) -> bool:
    """Calls tencent/Hunyuan3D-2mv Space if out_glb_path does not already exist."""
    if os.path.exists(out_glb_path) and os.path.getsize(out_glb_path) > 1_000_000:
        print(f"  [Hunyuan3D-2mv cached GLB found]: {out_glb_path} ({os.path.getsize(out_glb_path)/1e6:.2f} MB)")
        return True
    try:
        from gradio_client import Client, handle_file

        client = Client("tencent/Hunyuan3D-2mv")
        res = client.predict(
            caption=None,
            image=handle_file(views_paths["front"]),
            mv_image_front=handle_file(views_paths["front"]),
            mv_image_back=handle_file(views_paths["back"]),
            mv_image_left=handle_file(views_paths["left"]),
            mv_image_right=handle_file(views_paths["right"]),
            steps=5,
            guidance_scale=5.0,
            seed=1234,
            octree_resolution=192,
            check_box_rembg=True,
            num_chunks=8000,
            randomize_seed=False,
            api_name="/shape_generation",
        )
        glb_file = res[0]
        if isinstance(glb_file, dict) and "value" in glb_file:
            glb_file = glb_file["value"]
        if glb_file and os.path.exists(str(glb_file)):
            shutil.copyfile(str(glb_file), out_glb_path)
            return True
    except Exception as e:
        print(f"  [Hunyuan3D-2mv note]: {e}")
    return False


def main():
    parser = argparse.ArgumentParser(description="Build 1550 Spanish Main 3D Building Assets from 4-View Turnarounds")
    parser.add_argument("--manifest", required=True, help="JSON list of {id, name, turnaroundPath}")
    parser.add_argument("--out-dir", required=True, help="Directory for output .glb meshes and atlas")
    parser.add_argument("--try-hunyuan", action="store_true", help="Use Hunyuan3D-2mv LRM meshes")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    items = json.load(open(args.manifest))

    import torch
    from transformers import pipeline

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Loading Depth Anything V2 Small on {device} for multi-view facade relief extraction...")
    depth_pipe = pipeline(
        task="depth-estimation",
        model="depth-anything/Depth-Anything-V2-Small-hf",
        device=device,
    )

    fig = plt.figure(figsize=(20, 4.7 * len(items)), facecolor="#0c141c")
    summary = []
    lrm_templates = []

    for row, item in enumerate(items):
        asset_id = item["id"]
        name = item["name"]
        sheet_path = item["turnaroundPath"]
        print(f"\n=== Processing 4-View Orthographic Turnaround: {name} ({asset_id}) ===")

        sheet_im = Image.open(sheet_path).convert("RGB")
        raw_views = split_turnaround_2x2(sheet_im)
        seg_views = {}
        view_paths = {}

        asset_sub = os.path.join(args.out_dir, asset_id)
        os.makedirs(asset_sub, exist_ok=True)

        for vname, vim in raw_views.items():
            seg = segment_studio_background(vim)
            seg_views[vname] = seg
            vpath = os.path.join(asset_sub, f"mv_{vname}.png")
            seg.save(vpath)
            view_paths[vname] = vpath

        glb_path = os.path.join(args.out_dir, f"{asset_id}.glb")
        used_hunyuan = try_hunyuan3d_2mv(view_paths, glb_path) if args.try_hunyuan else False

        v_dec, f_dec, raw_hunyuan_tris = load_and_decimate_hunyuan_glb(glb_path, target_faces=3600)
        verts, faces, normals, v_rgb, kind, shade = project_triplane_materials_onto_mesh(
            v_dec, f_dec, seg_views, tex_res=256
        )

        # Pack 8-float vertex buffer [lx, ly, lz, nx, ny, nz, kind, shade] + uint16 index buffer
        v_pack = np.column_stack([verts, normals, kind[:, None], shade[:, None]]).astype("<f4")
        i_pack = faces.reshape(-1).astype("<u2")
        lrm_templates.append((asset_id, v_pack, i_pack))

        unique_k, counts_k = np.unique(kind.astype(int), return_counts=True)
        mat_stats = {int(k): round(float(c) / len(kind) * 100.0, 1) for k, c in zip(unique_k, counts_k)}
        print(
            f"  -> {asset_id}: Hunyuan3D-2mv raw={raw_hunyuan_tris:,} tris -> decimated={len(faces):,} tris "
            f"({len(verts):,} verts), materials={mat_stats}"
        )
        summary.append(
            {
                "id": asset_id,
                "name": name,
                "rawHunyuanTriangles": int(raw_hunyuan_tris),
                "decimatedVertices": int(len(verts)),
                "decimatedTriangles": int(len(faces)),
                "glbBytes": os.path.getsize(glb_path),
                "materialBreakdownPct": mat_stats,
                "hunyuan3d": used_hunyuan,
            }
        )

        # Column 1: 2x2 Orthographic Turnaround Sheet
        ax1 = fig.add_subplot(len(items), 4, row * 4 + 1)
        ax1.imshow(sheet_im)
        ax1.set_title(f"{name}\n1. 4-View Orthographic Turnaround", color="#f5bf77", fontsize=10, fontweight="bold")
        ax1.axis("off")

        # Column 2: Alpha-Segmented Orthographic Views
        seg_grid = Image.new("RGBA", (512, 512), (18, 30, 42, 255))
        for (vx, vy), vk in [((0, 0), "front"), ((256, 0), "back"), ((0, 256), "left"), ((256, 256), "right")]:
            thumb = seg_views[vk].resize((256, 256), Image.Resampling.BILINEAR)
            seg_grid.paste(thumb, (vx, vy), thumb)
        ax2 = fig.add_subplot(len(items), 4, row * 4 + 2)
        ax2.imshow(seg_grid)
        ax2.set_title("2. Segmented RGBA Silhouettes\n(mv_front / mv_back / mv_left / mv_right)", color="#e7eef6", fontsize=10)
        ax2.axis("off")

        # Column 3: Depth Anything V2 Facade Relief (Front & Left)
        d_front = np.asarray(depth_pipe(seg_views["front"].convert("RGB"))["depth"].resize((256, 256)))
        d_left = np.asarray(depth_pipe(seg_views["left"].convert("RGB"))["depth"].resize((256, 256)))
        d_pair = np.hstack([d_front, d_left])
        ax3 = fig.add_subplot(len(items), 4, row * 4 + 3)
        ax3.imshow(d_pair, cmap="magma")
        ax3.set_title("3. Facade Relief Extraction\n(Depth Anything V2 Front & Left)", color="#e7eef6", fontsize=10)
        ax3.axis("off")

        # Column 4: Connected Shaded Render of the Hunyuan3D-2mv 3D Mesh
        ax4 = fig.add_subplot(len(items), 4, row * 4 + 4, projection="3d")
        ax4.set_facecolor("#0c141c")
        tri_verts = verts[faces]
        fn = np.cross(tri_verts[:, 1] - tri_verts[:, 0], tri_verts[:, 2] - tri_verts[:, 0])
        fn_len = np.linalg.norm(fn, axis=-1, keepdims=True)
        fn = fn / np.maximum(1e-6, fn_len)
        sun_dir = np.array([0.48, 0.76, 0.43], dtype=np.float32)
        sun_dot = np.clip(np.sum(fn * sun_dir[None, :], axis=-1), 0.0, 1.0)
        hemi = 0.58 + 0.42 * np.clip(fn[:, 1], -1.0, 1.0)
        lit = np.clip(0.55 * hemi + 0.62 * sun_dot, 0.42, 1.18)[:, None]

        f_rgb = (v_rgb[faces[:, 0]].astype(np.float32) + v_rgb[faces[:, 1]] + v_rgb[faces[:, 2]]) / (3.0 * 255.0)
        f_cols = np.clip(f_rgb * lit, 0.0, 1.0)

        poly = Poly3DCollection(
            tri_verts[:, :, [0, 2, 1]],
            facecolors=f_cols,
            edgecolors=(0.12, 0.16, 0.20, 0.12),
            linewidths=0.15,
            alpha=1.0,
        )
        ax4.add_collection3d(poly)
        ax4.set_xlim(-0.48, 0.48)
        ax4.set_ylim(-0.48, 0.48)
        ax4.set_zlim(0.0, 0.96)
        ax4.view_init(elev=22, azim=-52)
        ax4.set_axis_off()
        ax4.set_title(
            f"4. Hunyuan3D-2mv 3D Mesh\n({raw_hunyuan_tris:,} → {len(faces):,} tris · Kinds 10–14)",
            color="#7ae582",
            fontsize=10,
            fontweight="bold",
        )

    plt.suptitle(
        "1550 Spanish Main — 4-View Orthographic Turnaround → Hunyuan3D-2mv + Depth Anything V2 3D Asset Pipeline",
        color="#f5bf77",
        fontsize=14,
        fontweight="bold",
        y=0.992,
    )
    plt.tight_layout(rect=[0, 0, 1, 0.982])
    atlas_out = os.path.join(args.out_dir, "building_3d_pipeline_atlas.png")
    plt.savefig(atlas_out, dpi=140, facecolor=fig.get_facecolor())
    print(f"\nSaved 3D Building Pipeline Atlas to {atlas_out}")

    with open(os.path.join(args.out_dir, "building_assets_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    # Export compact WebGPU binary bundle (buildings_1550_lrm.bin)
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
    print(f"Saved WebGPU LRM 3D Building Bundle to {lrm_bin_path} ({os.path.getsize(lrm_bin_path)/1024:.1f} KB)")


if __name__ == "__main__":
    main()
