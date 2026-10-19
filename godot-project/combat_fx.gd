extends Node3D
## Deterministic, bounded combat accents for the Web Compatibility renderer.
## The game owns the clock: no _process, timers, GPU particles, or shader TIME.

const DUST_CAPACITY := 32
const SPARK_CAPACITY := 40
const DEBRIS_CAPACITY := 20
const RING_CAPACITY := 4
const CANNON_LAUNCH := 0.2
const TRAIL_INTERVAL := 0.035
const GOLD := Color("ffce78")

var _enabled := true
var _reduced_motion := false
var _initialized := false
var _rng := RandomNumberGenerator.new()
var _batches: Dictionary = {}
var _rings: Array[Dictionary] = []
var _selection: MeshInstance3D
var _selection_material: StandardMaterial3D
var _selection_active := false
var _selection_position := Vector3.ZERO
var _selection_clock := 0.0
var _selection_color := GOLD
var _projectile: MeshInstance3D
var _flash: MeshInstance3D
var _flash_life := 0.0
var _flash_duration := 0.13
var _flash_direction := Vector3.FORWARD
var _flash_position := Vector3.ZERO
var _move_from := Vector3.ZERO
var _move_to := Vector3.ZERO
var _move_kind := ""
var _move_capture := false
var _move_impacted := false
var _trail_time := CANNON_LAUNCH
var _total_bursts := 0
var _trail_emissions := 0

func setup() -> void:
	if _initialized:
		return
	_initialized = true
	name = "CombatFX"
	_rng.seed = 608231
	var dust_mesh := SphereMesh.new()
	dust_mesh.radius = 0.5
	dust_mesh.height = 1.0
	dust_mesh.radial_segments = 8
	dust_mesh.rings = 4
	_make_batch("dust", dust_mesh, DUST_CAPACITY, false, true)
	var spark_mesh := BoxMesh.new()
	spark_mesh.size = Vector3.ONE
	_make_batch("sparks", spark_mesh, SPARK_CAPACITY, true, true)
	var debris_mesh := PrismMesh.new()
	debris_mesh.size = Vector3.ONE
	_make_batch("debris", debris_mesh, DEBRIS_CAPACITY, false, false)
	var ring_mesh := TorusMesh.new()
	ring_mesh.inner_radius = 0.965
	ring_mesh.outer_radius = 1.0
	ring_mesh.rings = 32
	ring_mesh.ring_segments = 6
	for index in range(RING_CAPACITY):
		var material := _effect_material(GOLD, true, true)
		var ring := _instance("ImpactRing%d" % index, ring_mesh, material)
		_rings.append({"node": ring, "material": material, "age": 0.0, "life": 0.0, "start": 0.2, "finish": 1.5, "color": GOLD})
	_selection_material = _effect_material(GOLD, true, true)
	_selection = _instance("SelectionRing", ring_mesh, _selection_material)
	var projectile_mesh := SphereMesh.new()
	projectile_mesh.radius = 0.22
	projectile_mesh.height = 0.44
	projectile_mesh.radial_segments = 10
	projectile_mesh.rings = 5
	_projectile = _instance("CannonProjectile", projectile_mesh, _effect_material(Color("ffd884"), true, false))
	var flash_mesh := BoxMesh.new()
	flash_mesh.size = Vector3.ONE
	_flash = _instance("SpearFlash", flash_mesh, _effect_material(Color("ffeab2"), true, false))
	_update_selection()

func configure(enabled: bool, reduced_motion: bool) -> void:
	var changed := _enabled != enabled or _reduced_motion != reduced_motion
	_enabled = enabled
	_reduced_motion = reduced_motion
	if not _initialized:
		return
	if changed:
		clear_transients()
	_update_selection()

func set_selection(position_at: Vector3, active: bool, color: String) -> void:
	var newly_selected := active and (not _selection_active or _selection_position.distance_squared_to(position_at) > 0.01)
	_selection_active = active
	_selection_position = position_at
	_selection_color = GOLD if color == "red" else Color("bce0dc")
	if newly_selected:
		_selection_clock = 0.0
	if not _initialized:
		return
	if newly_selected and _enabled and not _reduced_motion:
		_spawn_ring(position_at, 0.98, 1.35, 0.42, _selection_color)
	_update_selection()

func begin_move(from: Vector3, to: Vector3, kind: String, _color: String, capture: bool, _duration: float) -> void:
	_move_from = from
	_move_to = to
	_move_kind = kind
	_move_capture = capture
	_move_impacted = false
	_trail_time = CANNON_LAUNCH
	if not _enabled or _reduced_motion or not _initialized:
		return
	_spawn_dust(from, 6, 0.8)
	_total_bursts += 1
	_flush_batch("dust")

func sample_move(time: float, duration: float, _position_at: Vector3) -> void:
	if not _initialized:
		return
	var cannon_flight := _enabled and not _reduced_motion and _move_capture and _move_kind == "cannon" and not _move_impacted
	var impact_time := duration * 0.72
	_projectile.visible = cannon_flight and time >= CANNON_LAUNCH and time < impact_time
	if not _projectile.visible:
		return
	_projectile.position = _projectile_point(time, duration)
	# Fixed emission times make manual stepping and real playback agree.
	while _trail_time <= time and _trail_time < impact_time:
		_spawn_particle("sparks", _projectile_point(_trail_time, duration), Vector3(0, 0.12, 0), Vector3(0.13, 0.13, 0.24), Color("df8c3d"), 0.2, 0.0, true)
		_trail_time += TRAIL_INTERVAL
		_trail_emissions += 1
	_flush_batch("sparks")

func impact(position_at: Vector3, kind: String, _color: String, direction: Vector3) -> void:
	_move_impacted = true
	if not _initialized:
		return
	_projectile.visible = false
	if not _enabled:
		return
	_total_bursts += 1
	var count := 4 if _reduced_motion else 15
	var origin := position_at + Vector3(0, 0.9, 0)
	for index in range(count):
		var angle := TAU * float(index) / float(count) + _rng.randf_range(-0.16, 0.16)
		var speed := _rng.randf_range(0.8, 1.6) if _reduced_motion else _rng.randf_range(2.4, 4.7)
		var velocity := Vector3(cos(angle) * speed, _rng.randf_range(0.5, 2.6), sin(angle) * speed)
		_spawn_particle("sparks", origin, velocity, Vector3(0.055, 0.055, _rng.randf_range(0.2, 0.4)), Color("ffcc73") if index % 3 == 0 else Color("e99438"), 0.2 if _reduced_motion else _rng.randf_range(0.3, 0.48), 4.4)
	if not _reduced_motion:
		_spawn_dust(position_at, 9, 1.1)
		_spawn_ring(position_at, 0.22, 1.55 if kind == "cannon" else 1.35, 0.4, GOLD)
		for index in range(6):
			var angle := TAU * float(index) / 6.0 + _rng.randf_range(-0.3, 0.3)
			var velocity := Vector3(cos(angle) * 1.6, _rng.randf_range(1.3, 2.8), sin(angle) * 1.6)
			_spawn_particle("debris", position_at + Vector3(0, 0.25, 0), velocity, Vector3.ONE * _rng.randf_range(0.08, 0.14), Color("b6a084"), _rng.randf_range(0.35, 0.56), 8.0)
		if kind == "soldier":
			_flash_direction = Vector3(direction.x, 0, direction.z).normalized()
			if _flash_direction.length_squared() < 0.1:
				_flash_direction = Vector3.FORWARD
			_flash_position = position_at + Vector3(0, 1.25, 0) - _flash_direction * 0.7
			_flash_life = _flash_duration
			_update_flash()
	_flush_batches()

func land(position_at: Vector3, _kind: String, _color: String) -> void:
	if not _initialized:
		return
	_projectile.visible = false
	_move_capture = false
	if not _enabled or _reduced_motion:
		return
	_spawn_dust(position_at, 7, 0.65)
	_total_bursts += 1
	_flush_batch("dust")

func clear_transients() -> void:
	_move_capture = false
	_move_impacted = false
	_flash_life = 0.0
	if not _initialized:
		return
	for batch in _batches.values():
		batch.particles.clear()
		batch.mesh.visible_instance_count = 0
		batch.node.visible = false
	for ring in _rings:
		ring.life = 0.0
		ring.node.visible = false
	_projectile.visible = false
	_flash.visible = false
	_update_selection()

func tick(delta: float) -> void:
	if not _initialized or not _enabled or delta <= 0.0:
		return
	if _selection_active and not _reduced_motion:
		_selection_clock += delta
		_update_selection()
	for key in _batches:
		var particles: Array = _batches[key].particles
		if particles.is_empty():
			continue
		for index in range(particles.size() - 1, -1, -1):
			var particle: Dictionary = particles[index]
			particle.age += delta
			if particle.age >= particle.life:
				particles.remove_at(index)
		_flush_batch(key)
	for ring in _rings:
		if ring.life <= 0.0:
			continue
		ring.age += delta
		if ring.age >= ring.life:
			ring.life = 0.0
			ring.node.visible = false
			continue
		var progress: float = ring.age / ring.life
		var radius := lerpf(float(ring.start), float(ring.finish), 1.0 - pow(1.0 - progress, 2.0))
		ring.node.scale = Vector3(radius, 0.6, radius)
		var color: Color = ring.color
		color.a = (1.0 - progress) * 0.65
		ring.material.albedo_color = color
	if _flash_life > 0.0:
		_flash_life = maxf(0.0, _flash_life - delta)
		_update_flash()

func diagnostics() -> Dictionary:
	var active_particles := 0
	var active_trails := 0
	for batch in _batches.values():
		active_particles += batch.particles.size()
		for particle in batch.particles:
			if particle.trail:
				active_trails += 1
	var active_rings := 0
	for ring in _rings:
		if ring.life > 0.0:
			active_rings += 1
	var projectile_position := Vector3.ZERO if not _initialized else _projectile.position
	return {"enabled": _enabled, "reducedMotion": _reduced_motion, "activeParticles": active_particles, "capacity": DUST_CAPACITY + SPARK_CAPACITY + DEBRIS_CAPACITY, "activeRings": active_rings, "ringCapacity": RING_CAPACITY, "selectionActive": _selection_active, "selectionVisible": _initialized and _selection.visible, "projectileVisible": _initialized and _projectile.visible, "projectilePosition": [projectile_position.x, projectile_position.y, projectile_position.z], "activeTrails": active_trails, "flashVisible": _initialized and _flash.visible, "totalBursts": _total_bursts, "trailEmissions": _trail_emissions, "geometryBatches": _batches.size()}

func _make_batch(key: String, mesh: Mesh, capacity: int, unshaded: bool, transparent: bool) -> void:
	var batch := MultiMesh.new()
	batch.transform_format = MultiMesh.TRANSFORM_3D
	batch.use_colors = true
	batch.mesh = mesh
	batch.instance_count = capacity
	batch.visible_instance_count = 0
	var node := MultiMeshInstance3D.new()
	node.name = "Combat" + key.capitalize()
	node.multimesh = batch
	node.material_override = _effect_material(Color.WHITE, unshaded, transparent, true)
	node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	node.visible = false
	add_child(node)
	_batches[key] = {"mesh": batch, "node": node, "particles": [], "capacity": capacity}

func _effect_material(color: Color, unshaded: bool, transparent: bool, vertex_colors := false) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	material.vertex_color_use_as_albedo = vertex_colors
	material.roughness = 0.92
	if unshaded:
		material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	if transparent:
		material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		material.cull_mode = BaseMaterial3D.CULL_DISABLED
	return material

func _instance(instance_name: String, mesh: Mesh, material: Material) -> MeshInstance3D:
	var node := MeshInstance3D.new()
	node.name = instance_name
	node.mesh = mesh
	node.material_override = material
	node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	node.visible = false
	add_child(node)
	return node

func _spawn_particle(key: String, origin: Vector3, velocity: Vector3, size_at: Vector3, color: Color, life: float, gravity: float, trail := false) -> void:
	var batch: Dictionary = _batches[key]
	var particles: Array = batch.particles
	if particles.size() >= int(batch.capacity):
		particles.pop_front()
	particles.append({"origin": origin, "velocity": velocity, "size": size_at, "color": color, "age": 0.0, "life": life, "gravity": gravity, "rotation": Vector3(_rng.randf_range(-3, 3), _rng.randf_range(-3, 3), _rng.randf_range(-3, 3)), "trail": trail})

func _spawn_dust(position_at: Vector3, count: int, strength: float) -> void:
	for index in range(count):
		var angle := TAU * float(index) / float(count) + _rng.randf_range(-0.2, 0.2)
		var direction := Vector3(cos(angle), 0, sin(angle))
		var origin := Vector3(position_at.x, 0.56, position_at.z) + direction * _rng.randf_range(0.42, 0.72)
		var velocity := direction * _rng.randf_range(0.8, 1.3) * strength + Vector3(0, 0.24, 0)
		_spawn_particle("dust", origin, velocity, Vector3(0.38, 0.24, 0.38) * strength, Color(0.67, 0.55, 0.39, 0.3), _rng.randf_range(0.38, 0.62), 0.0)

func _spawn_ring(position_at: Vector3, start_radius: float, finish_radius: float, life: float, color: Color) -> void:
	var slot: Dictionary = _rings[0]
	for ring in _rings:
		if ring.life <= 0.0:
			slot = ring
			break
	slot.age = 0.0
	slot.life = life
	slot.start = start_radius
	slot.finish = finish_radius
	slot.color = color
	slot.node.position = Vector3(position_at.x, 0.535, position_at.z)
	slot.node.scale = Vector3(start_radius, 0.6, start_radius)
	var visible_color := color
	visible_color.a = 0.65
	slot.material.albedo_color = visible_color
	slot.node.visible = true

func _update_selection() -> void:
	if not _initialized:
		return
	_selection.visible = _enabled and _selection_active
	if not _selection.visible:
		return
	var breath := 0.0 if _reduced_motion else sin(_selection_clock * 3.4)
	var radius := 1.235 + breath * 0.035
	_selection.position = Vector3(_selection_position.x, 0.535, _selection_position.z)
	_selection.scale = Vector3(radius, 0.8, radius)
	var color := _selection_color
	color.a = 0.72 + breath * 0.12
	_selection_material.albedo_color = color

func _projectile_point(time: float, duration: float) -> Vector3:
	var progress := clampf((time - CANNON_LAUNCH) / maxf(duration * 0.72 - CANNON_LAUNCH, 0.01), 0.0, 1.0)
	var direction := (_move_to - _move_from).normalized()
	var start := _move_from + Vector3(0, 1.1, 0) + direction * 0.4
	var finish := _move_to + Vector3(0, 0.9, 0)
	return start.lerp(finish, progress) + Vector3(0, sin(progress * PI) * clampf(_move_from.distance_to(_move_to) * 0.3, 1.0, 3.2), 0)

func _update_flash() -> void:
	_flash.visible = _enabled and not _reduced_motion and _flash_life > 0.0
	if not _flash.visible:
		return
	var strength := _flash_life / _flash_duration
	var basis := Basis.looking_at(_flash_direction, Vector3.UP) * Basis.from_scale(Vector3(0.045, 0.045, 1.65 * strength))
	_flash.transform = Transform3D(basis, _flash_position)

func _flush_batches() -> void:
	for key in _batches:
		_flush_batch(key)

func _flush_batch(key: String) -> void:
	var batch: Dictionary = _batches[key]
	var particles: Array = batch.particles
	var mesh: MultiMesh = batch.mesh
	mesh.visible_instance_count = particles.size()
	batch.node.visible = not particles.is_empty()
	for index in range(particles.size()):
		var particle: Dictionary = particles[index]
		var age: float = particle.age
		var progress: float = age / particle.life
		var velocity: Vector3 = particle.velocity
		var position_at: Vector3 = particle.origin + velocity * age - Vector3(0, float(particle.gravity) * age * age * 0.5, 0)
		position_at.y = maxf(position_at.y, 0.51)
		var size_at: Vector3 = particle.size
		var basis := Basis.IDENTITY
		var color: Color = particle.color
		if key == "dust":
			size_at *= 0.55 + progress * 1.3
			color.a *= pow(1.0 - progress, 1.5)
		elif key == "sparks":
			var flight := velocity - Vector3(0, float(particle.gravity) * age, 0)
			if flight.length_squared() > 0.001:
				basis = Basis.looking_at(flight.normalized(), Vector3.RIGHT if absf(flight.normalized().dot(Vector3.UP)) > 0.95 else Vector3.UP)
			size_at *= 1.0 - progress * 0.6
			color.a *= 1.0 - progress
		else:
			basis = Basis.from_euler(particle.rotation * age * 3.0)
			size_at *= 1.0 - progress * progress
		# Scale the mesh's local axes before rotating its long axis into flight.
		mesh.set_instance_transform(index, Transform3D(basis * Basis.from_scale(size_at), position_at))
		mesh.set_instance_color(index, color)
