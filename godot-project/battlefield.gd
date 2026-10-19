extends Node3D
## Lightweight battlefield dressing for the Compatibility renderer.
## All military props sit outside the playable board, so their silhouettes never
## substitute for a piece. Repeated geometry is batched; fire adds no lights.

var _rng := RandomNumberGenerator.new()
var _font: Font
var _batches: Dictionary = {}
var _materials: Dictionary = {}
var _counts := {"rocks": 0, "wall_blocks": 0, "palisades": 0, "banners": 0, "braziers": 0, "smoke_puffs": 0, "embers": 0}

const CLOTH_SHADER := """
shader_type spatial;
render_mode cull_disabled;
uniform vec4 cloth_color : source_color = vec4(0.5, 0.035, 0.025, 1.0);
uniform float phase = 0.0;
varying float fold;
void vertex() {
    float loose = UV.y * UV.y;
    fold = sin(UV.x * 7.0 + UV.y * 4.0 + TIME * 1.8 + phase);
    VERTEX.z += loose * (fold * 0.14 + sin(TIME * 0.8 + phase) * 0.12);
    VERTEX.x += loose * sin(TIME * 1.4 + UV.y * 3.0 + phase) * 0.05;
}
void fragment() {
    float weave = sin(UV.x * 340.0) * sin(UV.y * 440.0) * 0.025;
    float border = step(UV.x, 0.055) + step(0.945, UV.x) + step(UV.y, 0.035);
    float emblem = (1.0 - smoothstep(0.016, 0.032, abs(length((UV - vec2(0.5, 0.40)) * vec2(1.0, 1.28)) - 0.23)));
    float slash = (1.0 - smoothstep(0.018, 0.034, abs(UV.x - 0.5))) * step(0.24, UV.y) * step(UV.y, 0.56);
    ALBEDO = mix(cloth_color.rgb * (0.91 + fold * 0.07 + weave), vec3(0.74, 0.52, 0.23), clamp(border + emblem * 0.8 + slash * 0.8, 0.0, 1.0));
    ROUGHNESS = 0.96;
}
"""

const FLAME_SHADER := """
shader_type spatial;
render_mode unshaded, cull_disabled;
void vertex() {
    float phase = INSTANCE_CUSTOM.r * 6.28318;
    float tip = clamp(VERTEX.y + 0.5, 0.0, 1.0);
    VERTEX.x += sin(TIME * 4.2 + phase + VERTEX.y * 5.0) * tip * 0.11;
    VERTEX.z += cos(TIME * 3.1 + phase + VERTEX.y * 7.0) * tip * 0.08;
    VERTEX.y *= 0.92 + sin(TIME * 6.0 + phase) * 0.08;
}
void fragment() {
    vec3 color = mix(vec3(1.0, 0.78, 0.23), vec3(0.94, 0.17, 0.015), clamp(1.0 - UV.y, 0.0, 1.0));
    ALBEDO = color;
    EMISSION = color * 1.8;
}
"""

const SMOKE_SHADER := """
shader_type spatial;
render_mode unshaded, cull_disabled, depth_draw_never;
varying float phase;
varying float age;
void vertex() {
    phase = INSTANCE_CUSTOM.r;
    age = fract(TIME * 0.115 + phase);
    float spread = 0.22 + age * 1.4;
    mat4 billboard = mat4(INV_VIEW_MATRIX[0], INV_VIEW_MATRIX[1], INV_VIEW_MATRIX[2], MODEL_MATRIX[3]);
    MODELVIEW_MATRIX = VIEW_MATRIX * billboard;
    VERTEX.xy *= spread;
    VERTEX.x += age * age * 0.9 + sin(age * 7.0 + phase * 13.0) * 0.12;
    VERTEX.y += age * 3.6;
}
void fragment() {
    vec2 p = UV * 2.0 - 1.0;
    float cloud = 1.0 - smoothstep(0.18, 1.0, dot(p, p));
    float irregular = 0.75 + 0.25 * sin(p.x * 8.0 + phase * 12.0) * sin(p.y * 7.0);
    ALBEDO = vec3(0.19, 0.18, 0.16);
    ALPHA = cloud * irregular * sin(age * 3.14159) * 0.18;
}
"""

const EMBER_SHADER := """
shader_type spatial;
render_mode unshaded, cull_disabled, depth_draw_never;
void vertex() {
    float phase = INSTANCE_CUSTOM.r;
    float age = fract(TIME * (0.19 + INSTANCE_CUSTOM.g * 0.1) + phase);
    VERTEX.y += age * 3.2;
    VERTEX.x += sin(age * 4.0 + phase * 20.0) * age * 0.7;
    VERTEX.z += cos(age * 3.0 + phase * 12.0) * age * 0.6;
}
void fragment() {
    ALBEDO = vec3(1.0, 0.38, 0.065);
    EMISSION = vec3(2.0, 0.65, 0.08);
}
"""

func setup(font: Font = null) -> void:
    name = "Battlefield"
    _font = font
    _rng.seed = 731203
    _make_materials()
    _build_terrain()
    _build_ridges()
    _build_fortifications()
    _build_scatter()
    _build_standards()
    _build_braziers()
    _flush_batches()

func diagnostics() -> Dictionary:
    var result := _counts.duplicate()
    result["geometry_batches"] = find_children("*", "MultiMeshInstance3D", true, false).size()
    result["mesh_instances"] = find_children("*", "MeshInstance3D", true, false).size()
    return result

func _make_materials() -> void:
    var earth := _mat(Color("b6afa0"), 0.95, true)
    if ResourceLoader.exists("res://textures/ground-albedo.jpg"):
        earth.albedo_texture = load("res://textures/ground-albedo.jpg")
        earth.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
    if ResourceLoader.exists("res://textures/ground-normal.png"):
        earth.normal_enabled = true
        earth.normal_texture = load("res://textures/ground-normal.png")
        earth.normal_scale = 0.7
    if ResourceLoader.exists("res://textures/ground-roughness.png"):
        earth.roughness_texture = load("res://textures/ground-roughness.png")
        earth.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
    _materials["earth"] = earth
    var stone := _mat(Color("8f9ba3"), 0.97, true)
    if ResourceLoader.exists("res://textures/ground-albedo.jpg"):
        stone.albedo_texture = load("res://textures/ground-albedo.jpg")
        stone.uv1_triplanar = true
        stone.uv1_world_triplanar = true
        stone.uv1_scale = Vector3(0.35, 0.35, 0.35)
        stone.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
    if ResourceLoader.exists("res://textures/ground-normal.png"):
        stone.normal_enabled = true
        stone.normal_texture = load("res://textures/ground-normal.png")
        stone.normal_scale = 0.42
    _materials["stone"] = stone
    var rock := stone.duplicate() as StandardMaterial3D
    rock.albedo_color = Color("b4bbc1")
    rock.roughness = 1.0
    rock.normal_scale = 0.55
    _materials["rock"] = rock
    for layer in ["ridge_near", "ridge_far"]:
        var ridge := stone.duplicate() as StandardMaterial3D
        ridge.albedo_color = Color("718ba1") if layer == "ridge_near" else Color("99aebb")
        ridge.roughness = 1.0
        ridge.uv1_scale = Vector3(0.055, 0.055, 0.055)
        ridge.normal_scale = 0.16
        # A small cool contribution keeps the distant rock faces atmospheric
        # under the warm battlefield sun without adding a light or a fog pass.
        ridge.emission_enabled = true
        ridge.emission = Color("243d55") if layer == "ridge_near" else Color("4c6475")
        ridge.emission_energy_multiplier = 0.42 if layer == "ridge_near" else 0.52
        _materials[layer] = ridge
    _materials["wood"] = _mat(Color("423329"), 0.94, true)
    _materials["iron"] = _mat(Color("343632"), 0.72)
    _materials["brass"] = _mat(Color("9d7040"), 0.64)
    _materials["coal"] = _mat(Color("291d18"), 0.97)

func _mat(color: Color, roughness: float, vertex_color := false) -> StandardMaterial3D:
    var material := StandardMaterial3D.new()
    material.albedo_color = color
    material.roughness = roughness
    material.vertex_color_use_as_albedo = vertex_color
    return material

func _shader(code: String) -> ShaderMaterial:
    var shader := Shader.new()
    shader.code = code
    var material := ShaderMaterial.new()
    material.shader = shader
    return material

func _build_terrain() -> void:
    var surface := SurfaceTool.new()
    surface.begin(Mesh.PRIMITIVE_TRIANGLES)
    # The inner apron remains low and flat; only distant terrain rises.
    for zi in range(-16, 16):
        for xi in range(-16, 16):
            var corners: Array[Vector3] = []
            for offset in [Vector2(0, 0), Vector2(1, 0), Vector2(0, 1), Vector2(1, 1)]:
                var x: float = (xi + offset.x) * 4.0
                var z: float = (zi + offset.y) * 4.0
                var edge: float = maxf(absf(x) - 17.0, absf(z) - 18.5)
                var height := -0.75 + maxf(0.0, edge) * (sin(x * 0.13 + z * 0.05) * cos(z * 0.11) * 0.025 + 0.005)
                corners.append(Vector3(x, height, z))
            var tone := _rng.randf_range(0.97, 1.03)
            var color := Color(tone, tone * 0.98, tone * 0.94)
            _triangle(surface, corners[0], corners[2], corners[1], color)
            _triangle(surface, corners[1], corners[2], corners[3], color)
    _mesh(surface.commit(), _materials["earth"], Vector3.ZERO, "EarthApron")
    # Distinct rubble banks keep the board visually grounded in the land.
    for side in [-1.0, 1.0]:
        for i in range(18):
            var x: float = side * _rng.randf_range(13.6, 19.5)
            var z := _rng.randf_range(-17.8, 17.8)
            _rock(Vector3(x, -0.55, z), Vector3(_rng.randf_range(0.5, 1.8), _rng.randf_range(0.18, 0.7), _rng.randf_range(0.5, 1.4)))

func _build_ridges() -> void:
    var ridge := _rock_mesh()
    for layer in range(2):
        var key := "ridge_far" if layer == 1 else "ridge_near"
        var base_distance := 40.0 + layer * 14.0
        for side in [-1.0, 1.0]:
            for i in range(11):
                var x := -53.0 + i * 10.5 + _rng.randf_range(-3.0, 3.0)
                var z: float = side * (base_distance + _rng.randf_range(-4.0, 4.0))
                var scale_at := Vector3(_rng.randf_range(8.0, 14.0), _rng.randf_range(6.0, 13.0) + layer * 2.0, _rng.randf_range(6.0, 11.0))
                scale_at.y *= 0.8
                _batch(key, ridge, _materials[key], _transform(Vector3(x, -1.0, z), scale_at, _rng.randf_range(-PI, PI)), Color(_rng.randf_range(0.85, 1.06), 1, 1))
            for i in range(6):
                var z := -27.0 + i * 11.0
                var scale_at := Vector3(_rng.randf_range(7.0, 12.0), _rng.randf_range(5.0, 9.0), _rng.randf_range(7.0, 11.0))
                scale_at.y *= 0.8
                _batch(key, ridge, _materials[key], _transform(Vector3(side * (base_distance + 3.0), -1.0, z), scale_at, _rng.randf_range(-PI, PI)))

func _build_fortifications() -> void:
    var cube := BoxMesh.new()
    cube.size = Vector3.ONE
    # Broken rear curtain wall, with a central breach instead of a solid backdrop.
    for side in [-1.0, 1.0]:
        for segment in range(8):
            var x: float = side * (6.8 + segment * 2.5)
            var courses: int = [1, 2, 3, 2, 3, 1, 3, 2][segment]
            for course in range(courses):
                var height := 0.84
                var position_at := Vector3(x + float(course % 2) * 0.18 + _rng.randf_range(-0.12, 0.12), -0.3 + course * 0.9, -23.7 + _rng.randf_range(-0.14, 0.14))
                _wall_block(cube, position_at, Vector3(_rng.randf_range(2.05, 2.4), height, 1.7), _rng.randf_range(-0.065, 0.065))
            if segment % 3 != 0:
                _wall_block(cube, Vector3(x, -0.3 + courses * 0.9, -23.7), Vector3(0.9, 0.8, 1.7))
        _tower(Vector3(side * 25.0, -0.75, -24.4), cube)
        # Low side walls leave the board open to both side camera presets.
        for segment in range(9):
            var z := -18.0 + segment * 3.8
            _wall_block(cube, Vector3(side * 24.2, -0.1, z), Vector3(1.8, 1.25, 3.45), _rng.randf_range(-0.08, 0.08))
            if segment % 2 == 0:
                _wall_block(cube, Vector3(side * 24.2, 0.8, z - 0.8), Vector3(1.9, 0.7, 0.9))
        # Short angled palisade pockets, never a fence around the playing area.
        for group in range(3):
            var center := Vector3(side * (18.7 + group * 0.65), -0.75, -11.0 + group * 10.0)
            for index in range(5):
                var point := center + Vector3(float(index - 2) * 0.48, 0, float(index - 2) * 0.22)
                _palisade(point, _rng.randf_range(1.65, 2.5), side * 0.09)
            var beam := _transform(center + Vector3(0, 0.6, 0), Vector3(2.75, 0.13, 0.15), -0.38)
            _batch("wood_beams", cube, _materials["wood"], beam)
    # Foreground wreckage is low enough to retain a clean front view.
    _broken_wheel(Vector3(-17.2, -0.42, 16.4), Vector3(-0.15, 0.4, 0.18))
    _broken_wheel(Vector3(19.1, -0.42, -3.8), Vector3(0.08, -0.6, -0.25))
    for i in range(12):
        _wall_block(cube, Vector3(_rng.randf_range(-23.0, 23.0), -0.39, _rng.randf_range(20.8, 24.5)), Vector3(_rng.randf_range(0.55, 1.7), _rng.randf_range(0.35, 0.7), _rng.randf_range(0.6, 1.3)), _rng.randf_range(-PI, PI))

func _tower(position_at: Vector3, cube: BoxMesh) -> void:
    for course in range(5):
        _wall_block(cube, position_at + Vector3(0, 0.5 + course * 1.0, 0), Vector3(4.8 - course * 0.13, 0.94, 4.8 - course * 0.13))
    for x in [-1.6, 1.6]:
        for z in [-1.6, 1.6]:
            _wall_block(cube, position_at + Vector3(x, 5.35, z), Vector3(1.2, 1.1, 1.2))

func _wall_block(mesh: Mesh, position_at: Vector3, scale_at: Vector3, yaw := 0.0) -> void:
    var tone := _rng.randf_range(0.78, 1.12)
    _batch("wall_blocks", mesh, _materials["stone"], _transform(position_at, scale_at, yaw), Color(tone, tone, tone))
    _counts.wall_blocks += 1

func _build_scatter() -> void:
    for i in range(110):
        var position_at := Vector3(_rng.randf_range(-30.0, 30.0), -0.61, _rng.randf_range(-31.0, 30.0))
        if absf(position_at.x) < 14.1 and absf(position_at.z) < 15.3:
            continue
        _rock(position_at, Vector3(_rng.randf_range(0.28, 1.15), _rng.randf_range(0.18, 0.7), _rng.randf_range(0.35, 1.25)))
    for side in [-1.0, 1.0]:
        for i in range(5):
            var pole := CylinderMesh.new()
            pole.top_radius = 0.035
            pole.bottom_radius = 0.045
            pole.height = 3.0
            pole.radial_segments = 5
            var spear := Node3D.new()
            spear.position = Vector3(side * _rng.randf_range(16.4, 17.6), 0.55, -17.0 + i * 8.5)
            spear.rotation = Vector3(_rng.randf_range(-0.3, 0.3), 0, side * _rng.randf_range(0.13, 0.3))
            add_child(spear)
            _batch("spear_shafts", pole, _materials["wood"], spear.transform)
            var blade := CylinderMesh.new()
            blade.top_radius = 0.0
            blade.bottom_radius = 0.15
            blade.height = 0.55
            blade.radial_segments = 4
            _batch("spear_heads", blade, _materials["iron"], spear.transform * Transform3D(Basis.IDENTITY, Vector3(0, 1.75, 0)))

func _rock(position_at: Vector3, scale_at: Vector3) -> void:
    var tone := _rng.randf_range(0.75, 1.17)
    _batch("rocks", _rock_mesh(), _materials["rock"], _transform(position_at, scale_at, _rng.randf_range(-PI, PI)), Color(tone, tone, tone))
    _counts.rocks += 1

func _rock_mesh() -> Mesh:
    if _batches.has("rock_mesh"):
        return _batches["rock_mesh"]
    var surface := SurfaceTool.new()
    surface.begin(Mesh.PRIMITIVE_TRIANGLES)
    var points: Array[Vector3] = []
    for i in range(7):
        var angle := i * TAU / 7.0
        points.append(Vector3(cos(angle), 0.05, sin(angle)))
    for i in range(7):
        var angle := i * TAU / 7.0 + 0.15
        points.append(Vector3(cos(angle) * 0.72, 0.68 + sin(i * 2.2) * 0.1, sin(angle) * 0.72))
    var peak := Vector3(-0.14, 1.0, 0.08)
    for i in range(7):
        var next := (i + 1) % 7
        _triangle(surface, points[i], points[i + 7], points[next], Color.WHITE)
        _triangle(surface, points[next], points[i + 7], points[next + 7], Color.WHITE)
        _triangle(surface, points[i + 7], peak, points[next + 7], Color.WHITE)
    var mesh := surface.commit()
    _batches["rock_mesh"] = mesh
    return mesh

func _palisade(position_at: Vector3, height: float, lean: float) -> void:
    var post := CylinderMesh.new()
    post.top_radius = 0.0
    post.bottom_radius = 0.15
    post.height = 1.0
    post.radial_segments = 5
    var rotation := Basis(Vector3.FORWARD, lean)
    var transform := Transform3D(rotation * Basis.from_scale(Vector3(1, height, 1)), position_at + Vector3(0, height * 0.5, 0))
    _batch("palisades", post, _materials["wood"], transform)
    _counts.palisades += 1

func _broken_wheel(position_at: Vector3, rotation_at: Vector3) -> void:
    var wheel := Node3D.new()
    wheel.position = position_at + Vector3(0, 0.8, 0)
    wheel.rotation = rotation_at
    add_child(wheel)
    var rim := TorusMesh.new()
    rim.inner_radius = 0.76
    rim.outer_radius = 0.96
    rim.rings = 12
    rim.ring_segments = 4
    var instance := _mesh(rim, _materials["wood"], Vector3.ZERO, "BrokenCartRim", wheel)
    instance.rotation_degrees.x = 90
    var spoke := BoxMesh.new()
    spoke.size = Vector3(1.66, 0.11, 0.13)
    for i in range(3):
        var part := _mesh(spoke, _materials["wood"], Vector3.ZERO, "CartSpoke", wheel)
        part.rotation.z = i * PI / 3.0

func _build_standards() -> void:
    for side in [-1.0, 1.0]:
        for end in [-1.0, 1.0]:
            var root := Node3D.new()
            root.name = "CrimsonStandard" if end > 0 else "CharcoalStandard"
            root.position = Vector3(side * 16.4, -0.75, end * 16.1)
            root.rotation.y = side * -0.2
            add_child(root)
            var pole := CylinderMesh.new()
            pole.top_radius = 0.055
            pole.bottom_radius = 0.09
            pole.height = 5.7
            pole.radial_segments = 8
            _batch("standard_poles", pole, _materials["wood"], root.transform * Transform3D(Basis.IDENTITY, Vector3(0, 2.85, 0)))
            var crossbar := CylinderMesh.new()
            crossbar.top_radius = 0.05
            crossbar.bottom_radius = 0.05
            crossbar.height = 2.3
            crossbar.radial_segments = 6
            _batch("standard_crossbars", crossbar, _materials["brass"], root.transform * Transform3D(Basis(Vector3.BACK, PI * 0.5), Vector3(0, 5.0, 0)))
            var spear := CylinderMesh.new()
            spear.top_radius = 0
            spear.bottom_radius = 0.17
            spear.height = 0.6
            spear.radial_segments = 4
            _batch("standard_finials", spear, _materials["brass"], root.transform * Transform3D(Basis.IDENTITY, Vector3(0, 5.9, 0)))
            var cloth := _shader(CLOTH_SHADER)
            cloth.set_shader_parameter("cloth_color", Color("8e261d") if end > 0 else Color("243a3d"))
            cloth.set_shader_parameter("phase", side * 2.7 + end)
            _mesh(_banner_mesh(), cloth, Vector3(0, 4.93, 0.04), "WavingCloth", root)
            _rock(root.position, Vector3(0.55, 0.4, 0.5))
            _counts.banners += 1

func _banner_mesh() -> ArrayMesh:
    var surface := SurfaceTool.new()
    surface.begin(Mesh.PRIMITIVE_TRIANGLES)
    for y in range(10):
        for x in range(6):
            var uv_a := Vector2(float(x) / 6.0, float(y) / 10.0)
            var uv_b := Vector2(float(x + 1) / 6.0, float(y) / 10.0)
            var uv_c := Vector2(float(x) / 6.0, float(y + 1) / 10.0)
            var uv_d := Vector2(float(x + 1) / 6.0, float(y + 1) / 10.0)
            for uv in [uv_a, uv_c, uv_b, uv_b, uv_c, uv_d]:
                var hem: float = maxf(0.0, uv.y - 0.8) * (0.3 + 0.7 * absf(sin(uv.x * 15.0)))
                surface.set_normal(Vector3.BACK)
                surface.set_uv(uv)
                surface.add_vertex(Vector3((uv.x - 0.5) * 1.9, -uv.y * 2.45 + hem, 0))
    return surface.commit()

func _build_braziers() -> void:
    var coal := SphereMesh.new()
    coal.radius = 0.47
    coal.height = 0.22
    coal.radial_segments = 10
    coal.rings = 4
    var bowl := CylinderMesh.new()
    bowl.top_radius = 0.62
    bowl.bottom_radius = 0.29
    bowl.height = 0.42
    bowl.radial_segments = 10
    var lip := TorusMesh.new()
    lip.inner_radius = 0.55
    lip.outer_radius = 0.64
    lip.rings = 10
    lip.ring_segments = 4
    var foot := CylinderMesh.new()
    foot.top_radius = 0.055
    foot.bottom_radius = 0.08
    foot.height = 1.3
    foot.radial_segments = 5
    var flame := CylinderMesh.new()
    flame.top_radius = 0.0
    flame.bottom_radius = 0.2
    flame.height = 1.0
    flame.radial_segments = 6
    flame.rings = 4
    var fire_material := _shader(FLAME_SHADER)
    var puff := QuadMesh.new()
    puff.size = Vector2(1.0, 1.0)
    var smoke_material := _shader(SMOKE_SHADER)
    var ember_mesh := SphereMesh.new()
    ember_mesh.radius = 0.025
    ember_mesh.height = 0.08
    ember_mesh.radial_segments = 4
    ember_mesh.rings = 2
    var ember_material := _shader(EMBER_SHADER)
    for side in [-1.0, 1.0]:
        for end in [-1.0, 1.0]:
            var center := Vector3(side * 14.6, -0.75, end * 13.9)
            _batch("brazier_bowls", bowl, _materials["iron"], Transform3D(Basis.IDENTITY, center + Vector3(0, 1.4, 0)))
            _batch("brazier_lips", lip, _materials["brass"], Transform3D(Basis.IDENTITY, center + Vector3(0, 1.62, 0)))
            _batch("brazier_coals", coal, _materials["coal"], Transform3D(Basis.IDENTITY, center + Vector3(0, 1.62, 0)))
            for i in range(3):
                var angle := i * TAU / 3.0
                var leg_basis := Basis.from_euler(Vector3(sin(angle) * 0.13, 0, -cos(angle) * 0.13))
                _batch("brazier_legs", foot, _materials["iron"], Transform3D(leg_basis, center + Vector3(cos(angle) * 0.31, 0.64, sin(angle) * 0.31)))
            for flame_index in range(3):
                var radius_scale := (0.18 + flame_index * 0.035) / 0.2
                var scale_at := Vector3(radius_scale, 0.68 + flame_index * 0.2, radius_scale)
                var position_at := center + Vector3((flame_index - 1) * 0.2, 1.94 + flame_index * 0.06, 0)
                _batch("fire_flames", flame, fire_material, _transform(position_at, scale_at), Color.WHITE, Color(_rng.randf(), 0, 0, 1))
            for puff_index in range(5):
                var phase: float = float(puff_index) / 5.0 + (side + end) * 0.043
                _batch("fire_smoke", puff, smoke_material, Transform3D(Basis.IDENTITY, center + Vector3(0, 2.2, 0)), Color.WHITE, Color(phase, 0, 0, 1))
                _counts.smoke_puffs += 1
            for i in range(6):
                var position_at := center + Vector3(_rng.randf_range(-0.3, 0.3), 1.95, _rng.randf_range(-0.3, 0.3))
                _batch("fire_embers", ember_mesh, ember_material, Transform3D(Basis.IDENTITY, position_at), Color.WHITE, Color(_rng.randf(), _rng.randf(), 0, 1))
                _counts.embers += 1
            _counts.braziers += 1

func _transform(position_at: Vector3, scale_at: Vector3, yaw := 0.0) -> Transform3D:
    return Transform3D(Basis(Vector3.UP, yaw) * Basis.from_scale(scale_at), position_at)

func _batch(key: String, mesh: Mesh, material: Material, transform: Transform3D, color := Color.WHITE, custom := Color(0, 0, 0, 0)) -> void:
    if not _batches.has(key):
        _batches[key] = {"mesh": mesh, "material": material, "transforms": [], "colors": [], "custom": []}
    _batches[key].transforms.append(transform)
    _batches[key].colors.append(color)
    _batches[key].custom.append(custom)

func _flush_batches() -> void:
    for key in _batches:
        if not _batches[key] is Dictionary:
            continue
        var data: Dictionary = _batches[key]
        var batch := MultiMesh.new()
        batch.transform_format = MultiMesh.TRANSFORM_3D
        batch.use_colors = true
        batch.use_custom_data = true
        batch.mesh = data.mesh
        batch.instance_count = data.transforms.size()
        for index in range(data.transforms.size()):
            batch.set_instance_transform(index, data.transforms[index])
            batch.set_instance_color(index, data.colors[index])
            batch.set_instance_custom_data(index, data.custom[index])
        var instance := MultiMeshInstance3D.new()
        instance.name = str(key).to_pascal_case()
        instance.multimesh = batch
        instance.material_override = data.material
        if key.begins_with("fire_"):
            instance.extra_cull_margin = 6.0
        if key.begins_with("ridge") or key.begins_with("fire_"):
            instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
        add_child(instance)

func _mesh(mesh: Mesh, material: Material, position_at: Vector3, mesh_name: String, parent: Node = self) -> MeshInstance3D:
    var instance := MeshInstance3D.new()
    instance.name = mesh_name
    instance.mesh = mesh
    instance.material_override = material
    instance.position = position_at
    parent.add_child(instance)
    return instance

func _triangle(surface: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, color: Color) -> void:
    var normal := (b - a).cross(c - a).normalized()
    # Godot front faces are clockwise. Keep the outward normal, but emit the
    # opposite winding from the mathematical cross product above.
    for point in [a, c, b]:
        surface.set_normal(normal)
        surface.set_color(color)
        surface.set_uv(Vector2(point.x, point.z) / 12.0)
        surface.add_vertex(point)
