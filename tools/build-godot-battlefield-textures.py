#!/usr/bin/env python3
"""Build original, deterministic PBR maps for the Godot battlefield.

No downloaded images, fonts, grid, lettering, or model textures are involved.
The river UVs match a 24.65 x 27.25 world-unit plane; board geometry owns the
playable grid. Requires Pillow and NumPy. Run from any working directory.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "godot-project" / "textures"
SEED = 0xBA771E


def smooth_noise(size: int, cells: int, rng: np.random.Generator) -> np.ndarray:
    """Smooth periodic value noise, with no discontinuity across a tile edge."""
    values = rng.random((cells, cells), dtype=np.float32)
    t = np.arange(size, dtype=np.float32) * cells / size
    cell = np.floor(t).astype(np.int32)
    f = t - cell
    f = f * f * (3.0 - 2.0 * f)
    a = values[cell[:, None] % cells, cell[None, :] % cells]
    b = values[cell[:, None] % cells, (cell[None, :] + 1) % cells]
    c = values[(cell[:, None] + 1) % cells, cell[None, :] % cells]
    d = values[(cell[:, None] + 1) % cells, (cell[None, :] + 1) % cells]
    top = a + (b - a) * f[None, :]
    bottom = c + (d - c) * f[None, :]
    return top + (bottom - top) * f[:, None]


def blurred(values: np.ndarray, radius: float) -> np.ndarray:
    image = Image.fromarray(np.uint8(np.clip(values, 0, 1) * 255))
    return np.asarray(image.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255


def fracture_field(size: int, rng: np.random.Generator, count: int, tile: bool) -> np.ndarray:
    image = Image.new("L", (size, size))
    draw = ImageDraw.Draw(image)
    copies = [-size, 0, size] if tile else [0]
    for _ in range(count):
        origin = rng.uniform(0, size, 2)
        angle = rng.uniform(0, np.pi * 2)
        count_steps = int(rng.integers(4, 13))
        points = [tuple(origin)]
        for index in range(count_steps):
            angle += rng.uniform(-0.65, 0.65)
            origin += np.array([np.cos(angle), np.sin(angle)]) * rng.uniform(2, 8) * size / 512
            points.append(tuple(origin))
        for dx in copies:
            for dy in copies:
                shifted = [(x + dx, y + dy) for x, y in points]
                draw.line(shifted, fill=int(rng.integers(110, 220)), width=1)
                if count_steps > 7:
                    split = points[count_steps // 2]
                    fork = [(split[0] + dx, split[1] + dy)]
                    branch_angle = angle + rng.uniform(0.5, 1.1)
                    for i in range(3):
                        fork.append((fork[-1][0] + np.cos(branch_angle) * size / 90,
                                     fork[-1][1] + np.sin(branch_angle) * size / 90))
                        branch_angle += rng.uniform(-0.3, 0.3)
                    draw.line(fork, fill=115, width=1)
    return np.asarray(image, dtype=np.float32) / 255


def build_material(name: str, size: int, seed: int, board: bool) -> list[dict]:
    rng = np.random.default_rng(seed)
    coarse = smooth_noise(size, 5, rng) - 0.5
    medium = smooth_noise(size, 24, rng) - 0.5
    grain = smooth_noise(size, 116, rng) - 0.5
    fine = rng.normal(0, 1, (size, size)).astype(np.float32)
    dust = smooth_noise(size, 11, rng)
    cracks = fracture_field(size, rng, 32 if board else 14, not board)
    crack_rim = blurred(cracks, 1.6) - blurred(cracks, 0.45)
    height = 0.48 + coarse * 0.19 + medium * 0.11 + grain * 0.07 + fine * 0.006
    height -= blurred(cracks, 0.5) * 0.13
    height += crack_rim * 0.10
    base = np.array([105, 93, 73] if board else [67, 61, 49], dtype=np.float32)
    pigment = coarse * 29 + medium * 12 + grain * 8 + fine * 1.4
    albedo = base + pigment[..., None] * np.array([1.0, 0.96, 0.82])
    albedo += np.maximum(0, dust - 0.54)[..., None] * np.array([16, 15, 12])
    albedo -= blurred(cracks, 0.5)[..., None] * np.array([42, 38, 31])
    albedo += crack_rim[..., None] * np.array([24, 22, 18])
    roughness = 0.86 + coarse * 0.08 + grain * 0.10

    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    u, v = xx / size, yy / size
    # Small impact depressions and carbon stains. Low contrast on the playing
    # field preserves piece readability; the perimeter has stronger wear.
    for _ in range(17 if board else 7):
        cx, cy = rng.uniform(0.04, 0.96, 2) * size
        if board and abs(cy / size - 0.5) < 0.08:
            continue
        radius = rng.uniform(0.012, 0.035) * size
        delta_x, delta_y = np.abs(xx - cx), np.abs(yy - cy)
        if not board:
            delta_x = np.minimum(delta_x, size - delta_x)
            delta_y = np.minimum(delta_y, size - delta_y)
        distance = np.hypot(delta_x * rng.uniform(0.8, 1.3), delta_y * rng.uniform(0.8, 1.3)) / radius
        scorch = np.exp(-distance * distance * 0.74) * (0.85 + medium)
        rim = np.exp(-((distance - 1.05) / 0.16) ** 2)
        albedo -= scorch[..., None] * np.array([17, 16, 13])
        albedo += rim[..., None] * np.array([3.5, 3.2, 2.7])
        height -= scorch * 0.035
        height += rim * 0.012
        roughness += scorch * 0.035

    if board:
        world_x = (u - 0.5) * 24.65
        world_z = (v - 0.5) * 27.25
        # Dry, shallow teal-grey river stone beneath engraved river lettering.
        bank_variation = (np.sin(world_x * 2.8) * 0.055 + np.sin(world_x * 8.1 + 0.7) * 0.027
                          + np.sin(world_x * 0.8) * 0.08)
        signed_bank = np.abs(world_z) - (0.94 + bank_variation)
        river = np.clip((-signed_bank + 0.12) / 0.24, 0, 1)
        river *= np.clip((10.5 - np.abs(world_x)) / 0.18, 0, 1)
        river_color = np.array([43, 65, 64], dtype=np.float32)
        wave = np.sin(world_z * 29 + np.sin(world_x * 1.1) * 2.2 + medium * 3)
        river_tone = river_color + (coarse * 14 + medium * 12 + grain * 4 + wave * 1.6)[..., None]
        albedo = albedo * (1 - river[..., None]) + river_tone * river[..., None]
        height -= river * 0.075
        height += river * wave * 0.007
        roughness = roughness * (1 - river) + (0.72 + medium * 0.1) * river
        bank = np.exp(-((signed_bank - 0.06) / 0.045) ** 2)
        bank *= np.clip((10.5 - np.abs(world_x)) / 0.18, 0, 1)
        albedo += bank[..., None] * np.array([18, 14, 8])
        height += bank * 0.025
        edge_distance = np.minimum.reduce([u, v, 1 - u, 1 - v])
        worn_edge = np.exp(-edge_distance * 70) * (0.6 + medium)
        albedo += worn_edge[..., None] * np.array([10, 8, 5])
        roughness += worn_edge * 0.03

    # Sparse bright mineral grains are bounded to avoid glitter or noisy albedo.
    mineral = np.maximum(0, smooth_noise(size, 330 if board else 170, rng) - 0.78)
    albedo += mineral[..., None] * np.array([38, 36, 31])
    height += mineral * 0.04
    # OpenGL (+Y) tangent-space normal. Albedo is sRGB; scalar and normal maps
    # are linear data. Godot detects normal maps from their material usage.
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    normal = np.stack([-dx * 8.0, dy * 8.0, np.ones_like(height)], axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    textures = [
        (f"{name}-albedo.jpg", np.uint8(np.clip(albedo, 0, 255)), "sRGB", {"quality": 91, "subsampling": 0, "optimize": True}),
        (f"{name}-normal.png", np.uint8(np.clip(normal * 0.5 + 0.5, 0, 1) * 255), "linear / OpenGL +Y", {"optimize": True}),
        (f"{name}-roughness.png", np.uint8(np.clip(roughness, 0, 1) * 255), "linear / red channel", {"optimize": True}),
    ]
    result = []
    for filename, pixels, space, settings in textures:
        path = DEST / filename
        Image.fromarray(pixels).save(path, **settings)
        resource = f"res://textures/{filename}"
        imported = f"res://.godot/imported/{filename}-{hashlib.md5(resource.encode()).hexdigest()}.ctex"
        # Keep all six maps mipmapped, including headless exports where Godot's
        # automatic 3D texture detection never sees a rendered scene.
        normal_map = 1 if "-normal" in filename else 2
        import_settings = f'''[remap]

importer="texture"
type="CompressedTexture2D"
path="{imported}"
metadata={{
"vram_texture": false
}}

[deps]

source_file="{resource}"
dest_files=["{imported}"]

[params]

compress/mode=0
compress/high_quality=false
compress/lossy_quality=0.7
compress/hdr_compression=1
compress/normal_map={normal_map}
compress/channel_pack=0
mipmaps/generate=true
mipmaps/limit=-1
roughness/mode=0
roughness/src_normal=""
process/fix_alpha_border=true
process/premult_alpha=false
process/normal_map_invert_y=false
process/hdr_as_srgb=false
process/hdr_clamp_exposure=false
process/size_limit=0
detect_3d/compress_to=0
'''
        Path(str(path) + ".import").write_text(import_settings)
        data = path.read_bytes()
        result.append({"path": f"textures/{filename}", "width": size, "height": size,
                       "colorSpace": space, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return result


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    assets = build_material("board", 1024, SEED, True)
    assets += build_material("ground", 512, SEED + 1, False)
    manifest = {
        "schemaVersion": 1,
        "generator": "tools/build-godot-battlefield-textures.py",
        "seed": SEED,
        "provenance": "Original deterministic procedural materials; no external raster source.",
        "scope": "Godot comparison only. Does not replace the Three.js board or any character texture.",
        "boardMapping": {"worldSizeXZ": [24.65, 27.25], "uvScale": [1, 1], "gridBaked": False,
                         "riverCentreZ": 0, "riverBankZApprox": [-1.0, 1.0], "riverExtentX": [-10.5, 10.5]},
        "recommendedMaterial": {"boardNormalScale": 0.65, "groundNormalScale": 0.7,
                                "roughness": 1.0, "roughnessTextureChannel": "red", "metallic": 0.0,
                                "filter": "linear with mipmaps", "groundUvMetresPerTile": 12.0},
        "assets": assets,
    }
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"textures": len(assets), "totalBytes": sum(a["bytes"] for a in assets), "manifest": str(DEST / "manifest.json")}, indent=2))


if __name__ == "__main__":
    main()
