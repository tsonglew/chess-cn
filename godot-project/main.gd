extends Node3D

const CELL := 2.6
const PIECE_Y := 0.62
const THRUST_DURATION := 1.2
const THRUST_IMPACT := 0.58
const TYPES := ["general", "advisor", "elephant", "horse", "chariot", "cannon", "soldier"]
const HEIGHTS := {"general": 2.45, "advisor": 2.18, "elephant": 2.36, "horse": 2.35, "chariot": 2.45, "cannon": 2.16, "soldier": 2.24}
const SINKS := {"general": 0.05, "advisor": 0.2, "elephant": 0.05, "horse": 0.18, "chariot": 0.05, "cannon": 0.05, "soldier": 0.05}
const GLYPHS := {"red": {"general": "帅", "advisor": "仕", "elephant": "相", "horse": "馬", "chariot": "車", "cannon": "炮", "soldier": "兵"}, "black": {"general": "將", "advisor": "士", "elephant": "象", "horse": "馬", "chariot": "車", "cannon": "砲", "soldier": "卒"}}

var camera: Camera3D
var pieces_root := Node3D.new()
var markers_root := Node3D.new()
var templates: Dictionary = {}
var piece_nodes: Dictionary = {}
var pedestal_batches: Dictionary = {}
var material_cache: Dictionary = {}
var state: Dictionary = {"pieces": []}
var host: JavaScriptObject
var bridge_callback: JavaScriptObject
var font: Font
var labels_visible := true
var view_name := "iso"
var orbit_yaw := 0.0
var orbit_pitch := 0.83
var camera_distance := 42.0
var camera_target := Vector3(0, 0.8, 0)
var camera_focused := false
var focus_distance := 11.5
var drag_start := Vector2.ZERO
var pointer_down := false
var pointer_dragged := false
var active_move: Dictionary = {}
var animation_names: Array[String] = []
var import_diagnostics: Dictionary = {}
var frame_count := 0
var elapsed_seconds := 0.0
var diagnostic_timer := 0.0
var last_animation: Dictionary = {}
var manual_clock := false
var board_line_transforms: Array[Transform3D] = []
var battlefield: Node3D
var keyboard_cursor: MultiMeshInstance3D
var cursor_row := 6
var cursor_col := 0

func _ready() -> void:
	if ResourceLoader.exists("res://fonts/ui-subset.ttf"):
		font = load("res://fonts/ui-subset.ttf")
	_build_environment()
	_build_board()
	_build_keyboard_cursor()
	battlefield = load("res://battlefield.gd").new()
	add_child(battlefield)
	battlefield.setup(font)
	add_child(pieces_root)
	add_child(markers_root)
	_build_pedestals()
	for kind in TYPES:
		var path := "res://models/%s.glb" % kind
		if ResourceLoader.exists(path):
			templates[kind] = load(path)
		else:
			push_error("Missing required model: " + path)
	_set_camera("iso")
	if OS.has_feature("web"):
		host = JavaScriptBridge.get_interface("GodotHost")
		bridge_callback = JavaScriptBridge.create_callback(_on_command)
		if host:
			host.registerCallback(bridge_callback)
		else:
			push_error("GodotHost bridge is not available")
	else:
		_sync_state({"state": _initial_state(), "selectedId": null, "legalMoves": []})
	# Discover imported names before the first JS state arrives.
	if templates.has("soldier"):
		var specimen: Node = templates["soldier"].instantiate()
		add_child(specimen)
		var player := _find_animation_player(specimen)
		if player:
			for clip in player.get_animation_list():
				if not animation_names.has(str(clip)):
					animation_names.append(str(clip))
				if str(clip).contains("SoldierThrust"):
					player.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
					player.play(clip)
					player.seek(0, true)
					var animation: Animation = player.get_animation(clip)
					var rest := _bone_sample(specimen)
					import_diagnostics = {"types": templates.keys(), "modelCount": templates.size(), "soldier": {"bones": rest.get("count", 0), "clip": str(clip), "duration": animation.length, "trackCount": animation.get_track_count(), "restPose": rest}}
		specimen.free()
	_emit({"type": "ready", "animations": animation_names, "engine": Engine.get_version_info().string, "modelTypes": templates.keys(), "renderer": "Compatibility / WebGL 2", "singleThread": true, "imports": import_diagnostics})
	_emit_metrics()

func _build_environment() -> void:
	var world := WorldEnvironment.new()
	var environment := Environment.new()
	# A real sky supplies broad highlights to the imported armor and brass.
	# All effects here work in the WebGL Compatibility renderer.
	var sky_material := ProceduralSkyMaterial.new()
	sky_material.sky_top_color = Color("273c57")
	sky_material.sky_horizon_color = Color("a99075")
	sky_material.ground_bottom_color = Color("252521")
	sky_material.ground_horizon_color = Color("8a735e")
	sky_material.sky_curve = 0.22
	var sky := Sky.new()
	sky.sky_material = sky_material
	sky.radiance_size = Sky.RADIANCE_SIZE_128
	environment.sky = sky
	environment.background_mode = Environment.BG_SKY
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color("a9c3dc")
	environment.ambient_light_energy = 0.48
	environment.reflected_light_source = Environment.REFLECTION_SOURCE_SKY
	environment.tonemap_mode = Environment.TONE_MAPPER_ACES
	environment.tonemap_exposure = 1.0
	environment.fog_enabled = true
	environment.fog_mode = Environment.FOG_MODE_DEPTH
	environment.fog_light_color = Color("6d726f")
	environment.fog_light_energy = 0.55
	environment.fog_depth_begin = 48.0
	environment.fog_depth_end = 115.0
	environment.fog_density = 0.65
	world.environment = environment
	add_child(world)
	var sun := DirectionalLight3D.new()
	sun.name = "SunsetKey"
	sun.rotation_degrees = Vector3(-47, -38, 0)
	sun.light_color = Color("ffcf91")
	sun.light_energy = 1.2
	sun.shadow_enabled = true
	sun.directional_shadow_max_distance = 65.0
	sun.shadow_bias = 0.035
	sun.directional_shadow_mode = DirectionalLight3D.SHADOW_ORTHOGONAL
	add_child(sun)
	var fill := DirectionalLight3D.new()
	fill.name = "CoolRim"
	fill.rotation_degrees = Vector3(-29, 145, 0)
	fill.light_color = Color("a2c5ee")
	fill.light_energy = 0.62
	add_child(fill)
	camera = Camera3D.new()
	camera.fov = 42
	camera.near = 0.1
	camera.far = 170
	camera.current = true
	add_child(camera)

func _build_board() -> void:
	var wood := _material(Color("32231c"), 0.88)
	var edge := _material(Color("967444"), 0.48)
	edge.metallic = 0.65
	var stone := _material(Color("302e2a"), 0.94)
	var surface := _terrain_material("board", 0.65)
	var ink := _material(Color("be9c5c"), 0.68)
	ink.metallic = 0.22
	_box(Vector3(26.05, 0.28, 28.65), Vector3(0, -0.5, 0), stone)
	_box(Vector3(25.6, 0.68, 28.2), Vector3(0, -0.02, 0), wood)
	_box(Vector3(25.25, 0.12, 27.85), Vector3(0, 0.32, 0), edge)
	# Plane UVs map the central worn riverbed exactly to the empty river rank.
	var plane := PlaneMesh.new()
	plane.size = Vector2(24.65, 27.25)
	var board_surface := MeshInstance3D.new()
	board_surface.name = "WeatheredBoard"
	board_surface.mesh = plane
	board_surface.material_override = surface
	board_surface.position.y = 0.45
	board_surface.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(board_surface)
	# Raised dark frame, brass corner protectors and inset metal pins.
	for side in [-1, 1]:
		_box(Vector3(0.22, 0.13, 27.7), Vector3(side * 12.46, 0.41, 0), wood)
		_box(Vector3(24.8, 0.13, 0.22), Vector3(0, 0.41, side * 13.76), wood)
		for end in [-1, 1]:
			_box(Vector3(0.66, 0.1, 1.65), Vector3(side * 12.46, 0.48, end * 12.95), edge)
			_box(Vector3(1.65, 0.1, 0.66), Vector3(side * 11.95, 0.48, end * 13.46), edge)
	var pin_mesh := CylinderMesh.new()
	pin_mesh.top_radius = 0.075
	pin_mesh.bottom_radius = 0.075
	pin_mesh.height = 0.045
	pin_mesh.radial_segments = 8
	var pins := MultiMesh.new()
	pins.transform_format = MultiMesh.TRANSFORM_3D
	pins.mesh = pin_mesh
	pins.instance_count = 14
	var pin_index := 0
	for x in [-12.46, 12.46]:
		for z in [-10.5, -7, -3.5, 0, 3.5, 7, 10.5]:
			pins.set_instance_transform(pin_index, Transform3D(Basis.IDENTITY, Vector3(x, 0.5, z)))
			pin_index += 1
	var pins_node := MultiMeshInstance3D.new()
	pins_node.name = "FramePins"
	pins_node.multimesh = pins
	pins_node.material_override = edge
	pins_node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(pins_node)
	for row in range(10):
		_line(Vector3(-4 * CELL, 0.46, (row - 4.5) * CELL), Vector3(4 * CELL, 0.46, (row - 4.5) * CELL), 0.028, ink)
	for col in range(9):
		var x := (col - 4) * CELL
		if col == 0 or col == 8:
			_line(Vector3(x, 0.46, -4.5 * CELL), Vector3(x, 0.46, 4.5 * CELL), 0.028, ink)
		else:
			_line(Vector3(x, 0.46, -4.5 * CELL), Vector3(x, 0.46, -0.5 * CELL), 0.028, ink)
			_line(Vector3(x, 0.46, 0.5 * CELL), Vector3(x, 0.46, 4.5 * CELL), 0.028, ink)
	for start in [0, 7]:
		_line(_board_point(start, 3, 0.46), _board_point(start + 2, 5, 0.46), 0.028, ink)
		_line(_board_point(start, 5, 0.46), _board_point(start + 2, 3, 0.46), 0.028, ink)
	for row in [2, 7, 3, 6]:
		var cols := [1, 7] if row == 2 or row == 7 else [0, 2, 4, 6, 8]
		for col in cols:
			var origin := _board_point(row, col, 0.465)
			for xsign in [-1, 1]:
				if (col == 0 and xsign == -1) or (col == 8 and xsign == 1):
					continue
				for zsign in [-1, 1]:
					_line(origin + Vector3(xsign * 0.22, 0, zsign * 0.42), origin + Vector3(xsign * 0.22, 0, zsign * 0.22), 0.025, ink)
					_line(origin + Vector3(xsign * 0.22, 0, zsign * 0.22), origin + Vector3(xsign * 0.42, 0, zsign * 0.22), 0.025, ink)
	_flush_board_lines(ink)
	_flat_label("楚 河", Vector3(-5.3, 0.48, 0), 0.015, Color("bfaa78"), self)
	_flat_label("汉 界", Vector3(5.3, 0.48, 0), 0.015, Color("bfaa78"), self)

func _build_keyboard_cursor() -> void:
	# Eight short corner strokes remain visible around occupied squares.
	var box := BoxMesh.new()
	box.size = Vector3.ONE
	var batch := MultiMesh.new()
	batch.transform_format = MultiMesh.TRANSFORM_3D
	batch.mesh = box
	batch.instance_count = 8
	var index := 0
	for xsign in [-1, 1]:
		for zsign in [-1, 1]:
			for horizontal in [true, false]:
				var size_at := Vector3(0.46, 0.035, 0.065) if horizontal else Vector3(0.065, 0.035, 0.46)
				var position_at := Vector3(xsign * (1.02 if horizontal else 1.22), 0, zsign * (1.22 if horizontal else 1.02))
				batch.set_instance_transform(index, Transform3D(Basis.from_scale(size_at), position_at))
				index += 1
	var material := _material(Color("9de5ff"), 1.0)
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	keyboard_cursor = MultiMeshInstance3D.new()
	keyboard_cursor.name = "KeyboardCursor"
	keyboard_cursor.multimesh = batch
	keyboard_cursor.material_override = material
	keyboard_cursor.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	keyboard_cursor.visible = false
	keyboard_cursor.position = _board_point(cursor_row, cursor_col, 0.515)
	add_child(keyboard_cursor)

func _set_keyboard_cursor(row: int, col: int, show_cursor: bool) -> void:
	cursor_row = clampi(row, 0, 9)
	cursor_col = clampi(col, 0, 8)
	keyboard_cursor.position = _board_point(cursor_row, cursor_col, 0.515)
	keyboard_cursor.visible = show_cursor
	_emit({"type": "cursor", "row": cursor_row, "col": cursor_col, "visible": show_cursor})

func _step_keyboard_cursor(dx: int, dy: int) -> void:
	if not active_move.is_empty():
		return
	var desired := Vector2(clampi(dx, -1, 1), clampi(dy, -1, 1))
	if desired == Vector2.ZERO:
		return
	desired = desired.normalized()
	var origin := _board_point(cursor_row, cursor_col)
	var screen_origin := camera.unproject_position(origin)
	var best_direction := Vector2i.ZERO
	var best_score := -INF
	# Choose a board neighbour by its screen direction, including after orbiting.
	# Clamp afterwards so a boundary key stays put instead of turning a corner.
	for direction in [Vector2i(0, -1), Vector2i(0, 1), Vector2i(-1, 0), Vector2i(1, 0)]:
		var neighbour := origin + Vector3(direction.x * CELL, 0, direction.y * CELL)
		var projected := camera.unproject_position(neighbour) - screen_origin
		var score := projected.normalized().dot(desired)
		if score > best_score:
			best_score = score
			best_direction = direction
	_set_keyboard_cursor(cursor_row + best_direction.y, cursor_col + best_direction.x, true)

func _zoom_camera(amount: float) -> void:
	if camera_focused:
		focus_distance = clampf(focus_distance + amount * 0.7, 6, 22)
	else:
		camera_distance = clampf(camera_distance + amount * 2.0, 24, 65)
	_update_camera()

func _terrain_material(prefix: String, relief: float) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.albedo_texture = load("res://textures/%s-albedo.jpg" % prefix)
	material.normal_enabled = true
	material.normal_texture = load("res://textures/%s-normal.png" % prefix)
	material.normal_scale = relief
	material.roughness_texture = load("res://textures/%s-roughness.png" % prefix)
	material.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
	material.roughness = 1.0
	material.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	return material

func _material(color: Color, roughness := 0.6) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	material.roughness = roughness
	return material

func _box(size: Vector3, position_at: Vector3, material: Material, parent: Node = self) -> MeshInstance3D:
	var mesh := BoxMesh.new()
	mesh.size = size
	var instance := MeshInstance3D.new()
	instance.mesh = mesh
	instance.material_override = material
	instance.position = position_at
	parent.add_child(instance)
	return instance

func _line(start: Vector3, finish: Vector3, thickness: float, _material: Material) -> void:
	var length := start.distance_to(finish)
	var rotation := Basis(Vector3.UP, atan2(finish.x - start.x, finish.z - start.z))
	var scale_basis := Basis.from_scale(Vector3(thickness, 0.015, length))
	board_line_transforms.append(Transform3D(rotation * scale_basis, (start + finish) * 0.5))

func _flush_board_lines(material: Material) -> void:
	# Every grid and palace stroke uses the same box and material. Batch these
	# static strokes so they do not each submit a draw call and shadow pass.
	var box := BoxMesh.new()
	box.size = Vector3.ONE
	var batch := MultiMesh.new()
	batch.transform_format = MultiMesh.TRANSFORM_3D
	batch.mesh = box
	batch.instance_count = board_line_transforms.size()
	for index in range(board_line_transforms.size()):
		batch.set_instance_transform(index, board_line_transforms[index])
	var instance := MultiMeshInstance3D.new()
	instance.name = "BoardLines"
	instance.multimesh = batch
	instance.material_override = material
	instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(instance)
	board_line_transforms.clear()

func _cylinder(radius: float, height: float, material: Material, parent: Node3D, y: float) -> MeshInstance3D:
	var mesh := CylinderMesh.new()
	mesh.top_radius = radius
	mesh.bottom_radius = radius
	mesh.height = height
	mesh.radial_segments = 40
	var instance := MeshInstance3D.new()
	instance.mesh = mesh
	instance.material_override = material
	instance.position.y = y
	parent.add_child(instance)
	return instance

func _flat_label(text_value: String, position_at: Vector3, pixel_scale: float, color: Color, parent: Node) -> Label3D:
	var label := Label3D.new()
	label.text = text_value
	if font:
		label.font = font
	label.font_size = 64
	label.pixel_size = pixel_scale
	label.modulate = color
	label.outline_size = 0
	label.shaded = false
	label.no_depth_test = false
	label.rotation_degrees.x = -90
	label.position = position_at
	parent.add_child(label)
	return label

func _board_point(row: float, col: float, height := PIECE_Y) -> Vector3:
	return Vector3((col - 4) * CELL, height, (row - 4.5) * CELL)

func _build_pedestals() -> void:
	# Every side shares one edge and one paint material. Keep the repeated bases
	# in four persistent batches instead of submitting two meshes per piece.
	var edge_mesh := CylinderMesh.new()
	edge_mesh.top_radius = 1.06
	edge_mesh.bottom_radius = 1.06
	edge_mesh.height = 0.32
	edge_mesh.radial_segments = 40
	var top_mesh := CylinderMesh.new()
	top_mesh.top_radius = 0.99
	top_mesh.bottom_radius = 0.99
	top_mesh.height = 0.08
	top_mesh.radial_segments = 40
	for color in ["red", "black"]:
		var red: bool = color == "red"
		var edge := _material(Color("886240") if red else Color("56626a"), 0.5)
		edge.metallic = 0.62
		var top := _material(Color("68332d") if red else Color("26343d"), 0.88)
		# Reuse the neutral wear map as a paint mask; avoid a flat plastic disk.
		top.albedo_texture = load("res://textures/ground-roughness.png")
		top.normal_enabled = true
		top.normal_texture = load("res://textures/ground-normal.png")
		top.normal_scale = 0.22
		top.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
		var layers: Dictionary = {}
		for layer in ["edge", "top"]:
			var batch := MultiMesh.new()
			batch.transform_format = MultiMesh.TRANSFORM_3D
			batch.mesh = edge_mesh if layer == "edge" else top_mesh
			batch.instance_count = 16
			batch.visible_instance_count = 0
			var instance := MultiMeshInstance3D.new()
			instance.name = "Pedestals_%s_%s" % [color, layer]
			instance.multimesh = batch
			instance.material_override = edge if layer == "edge" else top
			# The wider edge already casts the complete base footprint.
			instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON if layer == "edge" else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			add_child(instance)
			layers[layer] = instance
		pedestal_batches[color] = layers

func _sync_pedestals() -> void:
	var transforms: Dictionary = {"red": [], "black": []}
	var local_from_world := global_transform.affine_inverse()
	for node in piece_nodes.values():
		if node.is_visible_in_tree():
			var piece: Dictionary = node.get_meta("piece")
			transforms[piece.color].append(local_from_world * node.global_transform)
	for color in pedestal_batches:
		var positions: Array = transforms[color]
		for layer in pedestal_batches[color]:
			var batch: MultiMesh = pedestal_batches[color][layer].multimesh
			if batch.instance_count < positions.size():
				batch.instance_count = positions.size()
			var offset := Transform3D(Basis.IDENTITY, Vector3(0, 0.19 if layer == "top" else 0.0, 0))
			for index in range(positions.size()):
				var transform: Transform3D = positions[index] * offset
				batch.set_instance_transform(index, transform)
			# Compact only visible pieces, so a captured base disappears on the
			# same tick as its model and an empty side retains no stale instances.
			batch.visible_instance_count = positions.size()

func _pedestal_diagnostics() -> Dictionary:
	var teams: Dictionary = {}
	var batch_count := 0
	var visible_pieces := 0
	for color in pedestal_batches:
		var count: int = pedestal_batches[color].edge.multimesh.visible_instance_count
		teams[color] = count
		visible_pieces += count
		batch_count += pedestal_batches[color].size()
	return {"batches": batch_count, "visiblePieces": visible_pieces, "instances": visible_pieces * 2, "teams": teams}

func _new_piece(piece: Dictionary) -> Node3D:
	var root := Node3D.new()
	root.name = "Piece_%s" % str(piece.id)
	pieces_root.add_child(root)
	root.set_meta("piece", piece.duplicate(true))
	var red: bool = piece.color == "red"
	var figure := Node3D.new()
	figure.name = "Figure"
	figure.position.y = 0.34
	root.add_child(figure)
	if templates.has(piece.type):
		var imported: Node3D = templates[piece.type].instantiate()
		var rotation_wrapper := Node3D.new()
		rotation_wrapper.rotation.y = -PI / 2
		rotation_wrapper.add_child(imported)
		figure.add_child(rotation_wrapper)
		var bounds: Array = []
		_collect_bounds(rotation_wrapper, Transform3D.IDENTITY, bounds)
		if bounds.size() > 0:
			var box: AABB = bounds[0]
			var ratio: float = HEIGHTS[piece.type] / maxf(box.size.y, 0.001)
			rotation_wrapper.scale = Vector3.ONE * ratio
			var center := box.get_center()
			rotation_wrapper.position = Vector3(-center.x * ratio, -box.position.y * ratio - SINKS[piece.type], -center.z * ratio)
		_tint_meshes(imported, piece.type, piece.color)
		var player := _find_animation_player(imported)
		if player:
			player.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
			for clip in player.get_animation_list():
				if str(clip).contains("SoldierThrust"):
					root.set_meta("animation_player", player)
					root.set_meta("animation_clip", str(clip))
					player.play(clip)
					player.seek(0, true)
					if not animation_names.has(str(clip)):
						animation_names.append(str(clip))
	# An optional small badge leaves the complete character silhouette visible.
	var label := _flat_label(GLYPHS[piece.color][piece.type], Vector3(0, 0.245, 0.73), 0.0085, Color("fff0c9"), root)
	label.name = "Glyph"
	label.visible = labels_visible
	root.position = _board_point(piece.row, piece.col)
	figure.rotation.y = PI if red else 0.0
	var pick_bounds: Array = [AABB(Vector3(-1.06, -0.16, -1.06), Vector3(2.12, 0.4, 2.12))]
	_collect_bounds(figure, Transform3D.IDENTITY, pick_bounds)
	root.set_meta("pick_bounds", pick_bounds[0])
	return root

func _collect_bounds(node: Node, transform_from_root: Transform3D, result: Array) -> void:
	var next_transform := transform_from_root
	if node is Node3D:
		next_transform = transform_from_root * node.transform
	if node is MeshInstance3D and node.mesh:
		var source: AABB = node.mesh.get_aabb()
		for index in range(8):
			var point: Vector3 = next_transform * source.get_endpoint(index)
			if result.is_empty():
				result.append(AABB(point, Vector3.ZERO))
			else:
				result[0] = result[0].expand(point)
	for child in node.get_children():
		_collect_bounds(child, next_transform, result)

func _tint_meshes(node: Node, kind: String, color: String) -> void:
	if node is MeshInstance3D and node.mesh:
		node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		node.extra_cull_margin = 2.0
		for index in range(node.mesh.get_surface_count()):
			var original: Material = node.get_active_material(index)
			if original is StandardMaterial3D:
				var key := "%s:%s:%d" % [kind, color, original.get_instance_id()]
				if not material_cache.has(key):
					var tinted: StandardMaterial3D = original.duplicate()
					tinted.albedo_color *= Color(1.0, 0.78, 0.7) if color == "red" else Color(0.64, 0.78, 1.0)
					tinted.roughness = 0.63
					material_cache[key] = tinted
				node.set_surface_override_material(index, material_cache[key])
	for child in node.get_children():
		_tint_meshes(child, kind, color)

func _find_animation_player(node: Node) -> AnimationPlayer:
	if node is AnimationPlayer:
		return node
	for child in node.get_children():
		var candidate := _find_animation_player(child)
		if candidate:
			return candidate
	return null

func _on_command(arguments: Array) -> void:
	if arguments.is_empty():
		return
	var command = JSON.parse_string(str(arguments[0]))
	if not command is Dictionary:
		return
	match command.get("type", ""):
		"sync":
			active_move = {}
			if command.has("testMode"):
				manual_clock = bool(command.testMode)
			if command.get("config", {}).has("testMode"):
				manual_clock = bool(command.config.testMode)
			_sync_state(command)
		"move":
			_begin_move(command)
		"camera":
			_set_camera(command.get("view", "iso"))
		"cursor":
			_set_keyboard_cursor(int(command.get("row", cursor_row)), int(command.get("col", cursor_col)), bool(command.get("visible", false)))
		"cursor_step":
			_step_keyboard_cursor(int(command.get("dx", 0)), int(command.get("dy", 0)))
		"zoom":
			_zoom_camera(clampf(float(command.get("amount", 0)), -1, 1))
		"focus":
			camera_focused = bool(command.get("active", false))
			camera_target = _board_point(float(command.get("row", 4.5)), float(command.get("col", 4)), 1.05) if camera_focused else Vector3(0, 0.8, 0)
			focus_distance = 11.5
			_update_camera()
			_emit_metrics()
		"labels":
			labels_visible = bool(command.get("visible", true))
			for node in piece_nodes.values():
				node.get_node("Glyph").visible = labels_visible
		"advance":
			manual_clock = true
			_tick(maxf(float(command.get("ms", 0)), 0) / 1000.0)
			_emit_metrics()
		"clock":
			manual_clock = bool(command.get("manual", false))
		"inspect":
			_emit_metrics(command.get("requestId"))

func _sync_state(command: Dictionary) -> void:
	state = command.get("state", state).duplicate(true)
	var remaining: Dictionary = {}
	for piece in state.get("pieces", []):
		var key := int(piece.id)
		remaining[key] = true
		if piece_nodes.has(key):
			var previous: Dictionary = piece_nodes[key].get_meta("piece")
			if previous.type != piece.type or previous.color != piece.color:
				piece_nodes[key].visible = false
				piece_nodes[key].queue_free()
				piece_nodes.erase(key)
		if not piece_nodes.has(key):
			piece_nodes[key] = _new_piece(piece)
		var node: Node3D = piece_nodes[key]
		node.visible = true
		node.position = _board_point(piece.row, piece.col)
		node.rotation = Vector3.ZERO
		node.get_node("Figure").rotation.y = PI if piece.color == "red" else 0.0
		node.set_meta("piece", piece.duplicate(true))
		_sample_clip(node, 0)
	for key in piece_nodes.keys():
		if not remaining.has(key):
			piece_nodes[key].queue_free()
			piece_nodes.erase(key)
	_update_markers(command.get("selectedId"), command.get("legalMoves", []))
	_sync_pedestals()
	_emit_metrics()

func _update_markers(selected_id, moves: Array) -> void:
	for child in markers_root.get_children():
		child.queue_free()
	if selected_id != null and piece_nodes.has(int(selected_id)):
		var node: Node3D = piece_nodes[int(selected_id)]
		var marker := Node3D.new()
		markers_root.add_child(marker)
		marker.position = Vector3(node.position.x, 0.48, node.position.z)
		_cylinder(1.19, 0.025, _material(Color("f4c75f"), 0.3), marker, 0)
	for square in moves:
		var marker := Node3D.new()
		markers_root.add_child(marker)
		marker.position = _board_point(square.row, square.col, 0.49)
		_cylinder(0.23, 0.025, _material(Color("4eaa99"), 0.5), marker, 0)

func _begin_move(command: Dictionary) -> void:
	active_move = {}
	_sync_state({"state": command.before, "selectedId": null, "legalMoves": []})
	var move: Dictionary = command.move
	var key := int(move.pieceId)
	if not piece_nodes.has(key):
		_emit({"type": "error", "message": "Move piece does not exist"})
		return
	var node: Node3D = piece_nodes[key]
	var piece: Dictionary = node.get_meta("piece")
	var is_thrust: bool = piece.type == "soldier" and move.get("capturedId") != null
	var from := _board_point(move.from.row, move.from.col)
	var to := _board_point(move.to.row, move.to.col)
	active_move = {"node": node, "move": move, "after": command.after, "from": from, "to": to, "time": 0.0, "impact": false, "thrust": is_thrust, "duration": THRUST_DURATION if is_thrust else 0.46}
	if is_thrust:
		node.get_node("Figure").rotation.y = 0
		node.rotation.y = atan2(to.x - from.x, to.z - from.z)
		_animation_event("start", 0)
	_sync_pedestals()

func _process(delta: float) -> void:
	frame_count += 1
	elapsed_seconds += delta
	diagnostic_timer += delta
	if not manual_clock:
		_tick(delta)
	else:
		_sync_pedestals()
	if diagnostic_timer >= 1.0:
		diagnostic_timer = 0
		_emit_metrics()

func _tick(delta: float) -> void:
	if active_move.is_empty():
		_sync_pedestals()
		return
	active_move.time = minf(float(active_move.time) + delta, float(active_move.duration))
	var time: float = active_move.time
	var node: Node3D = active_move.node
	var from: Vector3 = active_move.from
	var to: Vector3 = active_move.to
	var progress: float
	var lift := 0.0
	if active_move.thrust:
		var distance := from.distance_to(to)
		var approach := (distance - minf(distance, 1.63)) / maxf(distance, 0.001)
		progress = approach * _smooth(time / 0.3) if time < 0.95 else approach + (1.0 - approach) * _smooth((time - 0.95) / 0.25)
		lift = sin(PI * clampf(time / 0.3, 0, 1)) * 0.12 if time < 0.3 else sin(PI * clampf((time - 0.95) / 0.25, 0, 1)) * 0.16 if time > 0.95 else 0.0
		_sample_clip(node, time)
	else:
		progress = _smooth(time / float(active_move.duration))
		lift = sin(progress * PI) * 0.25
	node.position = from.lerp(to, progress) + Vector3(0, lift, 0)
	var impact_time := THRUST_IMPACT if active_move.thrust else float(active_move.duration) * 0.72
	if time >= impact_time and not active_move.impact:
		active_move.impact = true
		var victim = active_move.move.get("capturedId")
		if victim != null and piece_nodes.has(int(victim)):
			piece_nodes[int(victim)].visible = false
		if active_move.thrust:
			_animation_event("impact", THRUST_IMPACT)
	if time >= float(active_move.duration):
		var after: Dictionary = active_move.after
		if active_move.thrust:
			_animation_event("end", THRUST_DURATION)
		active_move = {}
		_sync_state({"state": after, "selectedId": null, "legalMoves": []})
		_emit({"type": "move_done"})
	else:
		_sync_pedestals()

func _smooth(value: float) -> float:
	var x := clampf(value, 0, 1)
	return x * x * (3 - 2 * x)

func _sample_clip(node: Node3D, time: float) -> void:
	if node.has_meta("animation_player"):
		var player: AnimationPlayer = node.get_meta("animation_player")
		if not player.is_playing():
			player.play(node.get_meta("animation_clip"))
		player.seek(time, true)

func _animation_event(phase: String, time: float) -> void:
	var node: Node3D = active_move.node
	last_animation = {"type": "animation", "phase": phase, "clip": node.get_meta("animation_clip", "missing"), "time": time, "pieceId": active_move.move.pieceId, "bones": _bone_sample(node)}
	_emit(last_animation)

func _bone_sample(node: Node) -> Dictionary:
	if node is Skeleton3D:
		var sample: Array = []
		for index in range(node.get_bone_count()):
			var rotation: Quaternion = node.get_bone_pose_rotation(index)
			sample.append({"name": node.get_bone_name(index), "rotation": [rotation.x, rotation.y, rotation.z, rotation.w]})
		return {"count": node.get_bone_count(), "poses": sample}
	for child in node.get_children():
		var sample := _bone_sample(child)
		if not sample.is_empty():
			return sample
	return {}

func _set_camera(view: String) -> void:
	view_name = view
	match view:
		"top":
			orbit_yaw = 0
			orbit_pitch = 1.568
			camera_distance = 40
		"front":
			orbit_yaw = 0
			orbit_pitch = 0.59
			camera_distance = 43
		"side":
			orbit_yaw = PI / 2
			orbit_pitch = 0.82
			camera_distance = 43
		_:
			view_name = "iso"
			orbit_yaw = -0.22
			orbit_pitch = 0.91
			camera_distance = 47
	_update_camera()
	_emit({"type": "camera", "view": view_name})

func _update_camera() -> void:
	var aspect := get_viewport().get_visible_rect().size.aspect()
	var distance := focus_distance if camera_focused else camera_distance
	var responsive_distance := distance * maxf(1.0, 1.0 / maxf(aspect, 0.4))
	camera.position = Vector3(sin(orbit_yaw) * cos(orbit_pitch), sin(orbit_pitch), cos(orbit_yaw) * cos(orbit_pitch)) * responsive_distance + camera_target
	camera.look_at(camera_target, Vector3.UP)

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_SIZE_CHANGED and is_instance_valid(camera):
		_update_camera()

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT:
			if event.pressed:
				pointer_down = true
				pointer_dragged = false
				drag_start = event.position
			else:
				if pointer_down and not pointer_dragged:
					_pick_square(event.position)
				pointer_down = false
		elif event.pressed and event.button_index in [MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN]:
			_zoom_camera(-1.0 if event.button_index == MOUSE_BUTTON_WHEEL_UP else 1.0)
	elif event is InputEventMouseMotion and pointer_down:
		if event.position.distance_to(drag_start) > 5:
			pointer_dragged = true
		if pointer_dragged:
			orbit_yaw -= event.relative.x * 0.006
			orbit_pitch = clampf(orbit_pitch + event.relative.y * 0.004, 0.35, 1.568)
			view_name = "orbit"
			_update_camera()

func _pick_square(screen: Vector2) -> void:
	if not active_move.is_empty():
		return
	var ray_origin := camera.project_ray_origin(screen)
	var ray_direction := camera.project_ray_normal(screen)
	var nearest_distance := INF
	var nearest_piece: Dictionary = {}
	# Test the actual character volume before the board plane so that clicking
	# a head in a low camera view selects that piece, rather than the row behind it.
	for node in piece_nodes.values():
		if not node.visible:
			continue
		var inverse: Transform3D = node.global_transform.affine_inverse()
		var bounds: AABB = node.get_meta("pick_bounds")
		var point = bounds.intersects_ray(inverse * ray_origin, inverse.basis * ray_direction)
		if point != null:
			var distance: float = ray_origin.distance_squared_to(node.global_transform * point)
			if distance < nearest_distance:
				nearest_distance = distance
				nearest_piece = node.get_meta("piece")
	if not nearest_piece.is_empty():
		_emit({"type": "square", "row": nearest_piece.row, "col": nearest_piece.col})
		return
	var hit = Plane(Vector3.UP, PIECE_Y).intersects_ray(ray_origin, ray_direction)
	if hit == null:
		return
	var col := roundi(hit.x / CELL + 4)
	var row := roundi(hit.z / CELL + 4.5)
	if row >= 0 and row <= 9 and col >= 0 and col <= 8:
		_emit({"type": "square", "row": row, "col": col})

func _emit_metrics(request_id = null) -> void:
	var visuals: Array = []
	for node in piece_nodes.values():
		var piece: Dictionary = node.get_meta("piece")
		var projected := camera.unproject_position(node.position)
		var head_projected := camera.unproject_position(node.position + Vector3(0, 2.1, 0))
		var visual := {"id": piece.id, "type": piece.type, "color": piece.color, "visible": node.visible, "position": [node.position.x, node.position.y, node.position.z], "facing": node.rotation.y + node.get_node("Figure").rotation.y, "screen": [projected.x, projected.y], "headScreen": [head_projected.x, head_projected.y]}
		if piece.type == "soldier" and manual_clock:
			visual.bones = _bone_sample(node)
		visuals.append(visual)
	var metrics := {"type": "metrics", "fps": Engine.get_frames_per_second(), "frames": frame_count, "elapsed": elapsed_seconds, "pieces": piece_nodes.size(), "visualPieces": visuals, "imports": import_diagnostics, "drawCalls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME), "primitives": Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME), "objects": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME), "camera": view_name, "manualClock": manual_clock, "animation": last_animation, "animating": not active_move.is_empty(), "viewport": [get_viewport().get_visible_rect().size.x, get_viewport().get_visible_rect().size.y]}
	if not active_move.is_empty():
		metrics.animationTime = active_move.time
		metrics.bones = _bone_sample(active_move.node)
		var victim = active_move.move.get("capturedId")
		metrics.targetVisualAlive = victim != null and piece_nodes.has(int(victim)) and piece_nodes[int(victim)].visible
	if request_id != null:
		metrics.requestId = request_id
	metrics.battlefield = battlefield.diagnostics() if is_instance_valid(battlefield) else {}
	metrics.pedestals = _pedestal_diagnostics()
	var cursor_screen := camera.unproject_position(keyboard_cursor.position)
	metrics.keyboardCursor = {"row": cursor_row, "col": cursor_col, "visible": keyboard_cursor.visible, "screen": [cursor_screen.x, cursor_screen.y]}
	metrics.cameraDistance = focus_distance if camera_focused else camera_distance
	metrics.cameraPosition = [camera.position.x, camera.position.y, camera.position.z]
	metrics.focused = camera_focused
	metrics.cameraTarget = [camera_target.x, camera_target.y, camera_target.z]
	_emit(metrics)

func _emit(event: Dictionary) -> void:
	if host:
		host.receive(JSON.stringify(event))
	elif event.type in ["ready", "animation", "error"]:
		print(JSON.stringify(event))

func _initial_state() -> Dictionary:
	var pieces: Array = []
	var back := ["chariot", "horse", "elephant", "advisor", "general", "advisor", "elephant", "horse", "chariot"]
	for col in range(9):
		pieces.append({"id": pieces.size(), "type": back[col], "color": "black", "row": 0, "col": col})
		pieces.append({"id": pieces.size(), "type": back[col], "color": "red", "row": 9, "col": col})
	for team in ["black", "red"]:
		for col in [1, 7]:
			pieces.append({"id": pieces.size(), "type": "cannon", "color": team, "row": 2 if team == "black" else 7, "col": col})
	for col in [0, 2, 4, 6, 8]:
		pieces.append({"id": pieces.size(), "type": "soldier", "color": "black", "row": 3, "col": col})
		pieces.append({"id": pieces.size(), "type": "soldier", "color": "red", "row": 6, "col": col})
	return {"pieces": pieces, "turn": "red"}
