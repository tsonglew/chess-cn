extends SceneTree

var game: Node3D
var failures: Array[String] = []

func _initialize() -> void:
	call_deferred("_run")

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures.append(message)
		push_error(message)

func _command(value: Dictionary) -> void:
	game._on_command([JSON.stringify(value)])

func _scenario(kind: String, capture := false) -> Dictionary:
	var target := {"row": 5, "col": 4}
	if kind == "horse":
		target = {"row": 4, "col": 5}
	elif kind in ["chariot", "cannon"]:
		target = {"row": 2, "col": 4}
	var actor := {"id": 1, "type": kind, "color": "red", "row": 6, "col": 4}
	var before := {"pieces": [actor], "turn": "red"}
	if capture:
		before.pieces.append({"id": 2, "type": "soldier", "color": "black", "row": target.row, "col": target.col})
	var after := {"pieces": [actor.duplicate(true)], "turn": "black"}
	after.pieces[0].row = target.row
	after.pieces[0].col = target.col
	return {"type": "move", "before": before, "after": after, "move": {"pieceId": 1, "from": {"row": 6, "col": 4}, "to": target, "capturedId": 2 if capture else null}}

func _rest_pose(node: Node3D, target: Dictionary, phase: String) -> void:
	var figure: Node3D = node.get_node("Figure")
	_check(node.position.distance_to(game._board_point(target.row, target.col)) < 0.0001, phase + ": exact target square")
	_check(node.rotation.is_equal_approx(Vector3.ZERO), phase + ": base rotation reset")
	_check(node.scale.is_equal_approx(Vector3.ONE), phase + ": base scale reset")
	_check(figure.position.is_equal_approx(Vector3(0, 0.34, 0)), phase + ": body offset reset")
	_check(figure.rotation.is_equal_approx(Vector3(0, PI, 0)), phase + ": team facing and tilt reset")
	_check(figure.scale.is_equal_approx(Vector3.ONE), phase + ": squash reset")

func _run() -> void:
	game = load("res://main.tscn").instantiate()
	root.add_child(game)
	game.manual_clock = true
	await process_frame
	var elevations: Dictionary = {}
	for kind in ["soldier", "horse", "chariot", "cannon", "advisor", "elephant", "general"]:
		var scenario := _scenario(kind)
		_command(scenario)
		var duration: float = game.active_move.duration
		game._tick(duration * 0.4)
		var actor: Node3D = game.piece_nodes[1]
		elevations[kind] = actor.position.y - game.PIECE_Y
		_check(actor.position.distance_to(game._board_point(6, 4)) > 0.05, kind + ": mid-move position must advance")
		game._tick(duration * 0.6)
		_check(game.active_move.is_empty(), kind + ": motion ends at advertised duration")
		_rest_pose(actor, scenario.move.to, kind)
		var landed: Dictionary = game.combat_fx.diagnostics()
		_check(landed.activeParticles > 0 or landed.activeRings > 0, kind + ": landing emits a visible effect")
		_command({"type": "sync", "state": scenario.after})
		var acknowledged: Dictionary = game.combat_fx.diagnostics()
		_check(acknowledged.activeParticles == landed.activeParticles and acknowledged.activeRings == landed.activeRings, kind + ": ordinary host sync preserves landing effects")
		game._tick(4.0)
		var expired: Dictionary = game.combat_fx.diagnostics()
		_check(expired.activeParticles == 0 and expired.activeRings == 0 and not expired.projectileVisible, kind + ": large time advance expires every transient")
	_check(elevations.horse > 0.7, "Horse has a clearly elevated leap")
	_check(elevations.soldier > 0.04 and elevations.soldier < 0.2, "Soldier keeps a small walking step")
	_check(absf(elevations.chariot) < 0.001, "Chariot charges along the ground")
	_check(elevations.elephant > elevations.advisor and elevations.advisor > elevations.general, "Heavy, guarded and commanding steps retain distinct lift")

	# A nine-rank charge must not remove the target while still 1.72 cells away.
	var charge := _scenario("chariot", true)
	charge.before.pieces[0].row = 9
	charge.before.pieces[0].col = 0
	charge.before.pieces[1].row = 0
	charge.before.pieces[1].col = 0
	charge.after.pieces[0].row = 0
	charge.after.pieces[0].col = 0
	charge.move.from = {"row": 9, "col": 0}
	charge.move.to = {"row": 0, "col": 0}
	_command(charge)
	var charge_duration: float = game.active_move.duration
	var charge_target: Vector3 = game._board_point(0, 0)
	var charge_start_bursts: int = game.combat_fx.diagnostics().totalBursts
	game._tick(charge_duration * 0.72)
	var chariot: Node3D = game.piece_nodes[1]
	_check(chariot.position.distance_to(charge_target) > 4.0, "Long chariot charge is still far from its target at 72 percent")
	_check(game.piece_nodes[2].visible and not game.active_move.impact, "Long chariot victim stays visible until physical contact")
	_check(game.combat_fx.diagnostics().totalBursts == charge_start_bursts, "Long chariot charge does not emit premature impact sparks")
	var contact_checks := 0
	while not game.active_move.is_empty() and not game.active_move.impact and contact_checks < 50:
		_check(game.piece_nodes[2].visible, "Chariot target remains alive before entering the contact range")
		game._tick(0.005)
		contact_checks += 1
	_check(not game.active_move.is_empty() and game.active_move.impact, "Long chariot charge reaches contact before settling")
	_check(chariot.position.distance_to(charge_target) <= 1.0, "Chariot impact occurs within one world unit of the actual target")
	_check(not game.piece_nodes[2].visible, "Chariot victim disappears on the contact tick")
	var charge_contact_fx: Dictionary = game.combat_fx.diagnostics()
	_check(charge_contact_fx.totalBursts == charge_start_bursts + 1 and charge_contact_fx.activeRings > 0, "Chariot contact triggers exactly one impact burst with its visible ring")
	game._tick(charge_duration)
	_check(game.active_move.is_empty() and game.piece_nodes.size() == 1, "Long chariot capture completes without a stale victim")
	_rest_pose(chariot, charge.move.to, "Long chariot capture")
	game._tick(4.0)
	var charge_settled: Dictionary = game.combat_fx.diagnostics()
	_check(charge_settled.activeParticles == 0 and charge_settled.activeRings == 0 and not charge_settled.projectileVisible, "Long chariot capture leaves no lingering effects")

	var cannon := _scenario("cannon", true)
	_command(cannon)
	game._tick(0.2)
	var cannon_node: Node3D = game.piece_nodes[1]
	_check(cannon_node.position.distance_to(game._board_point(6, 4)) < 0.0001, "Cannon waits on the source square during its firing phase")
	_check(cannon_node.get_node("Figure").position.distance_to(Vector3(0, 0.34, 0)) > 0.1, "Cannon visibly recoils before projectile impact")
	game._tick(0.447)
	_check(game.piece_nodes[2].visible, "Cannon victim remains visible before 0.648 seconds")
	game._tick(0.002)
	_check(not game.piece_nodes[2].visible, "Cannon removes victim at 0.648-second impact")
	game._tick(0.251)
	_check(game.active_move.is_empty() and game.piece_nodes.size() == 1, "Cannon capture completes at 0.9 seconds")
	_rest_pose(cannon_node, cannon.move.to, "Cannon capture")

	var thrust := _scenario("soldier", true)
	_command(thrust)
	var soldier: Node3D = game.piece_nodes[1]
	_check(game._bone_sample(soldier).get("count", 0) == 20, "Original soldier rig retains 20 bones")
	_check(soldier.get_meta("animation_clip") == "SoldierThrust", "Original SoldierThrust clip is reused")
	game._tick(0.579)
	_check(game.piece_nodes[2].visible, "Soldier victim remains visible before imported 0.58-second impact")
	game._tick(0.002)
	_check(not game.piece_nodes[2].visible, "Soldier impact remains exactly 0.58 seconds")
	game._tick(0.619)
	_check(game.active_move.is_empty(), "Original soldier thrust duration stays 1.2 seconds")
	_rest_pose(soldier, thrust.move.to, "Soldier thrust")

	# Reset an interrupted pose as undo/restart do; no stale lean or FX survives.
	var interrupted := _scenario("horse")
	_command(interrupted)
	game._tick(0.25)
	_command({"type": "sync", "state": interrupted.before, "resetEffects": true})
	_rest_pose(game.piece_nodes[1], interrupted.move.from, "Interrupted move reset")
	_check(game.active_move.is_empty(), "Explicit state sync cancels an active move")
	var reset: Dictionary = game.combat_fx.diagnostics()
	_check(reset.activeParticles == 0 and reset.activeRings == 0 and not reset.projectileVisible, "Undo/restart reset clears all transient effects")

	_command({"type": "effects", "enabled": false, "reducedMotion": false})
	_command(_scenario("horse", true))
	game._tick(0.66)
	var disabled: Dictionary = game.combat_fx.diagnostics()
	_check(not disabled.enabled and disabled.activeParticles == 0 and disabled.activeRings == 0 and not disabled.projectileVisible, "Effects-off capture creates no transient visuals")
	_command({"type": "effects", "enabled": true, "reducedMotion": true})
	_command(_scenario("horse"))
	game._tick(0.3)
	var reduced_actor: Node3D = game.piece_nodes[1]
	_check(is_equal_approx(reduced_actor.position.y, game.PIECE_Y), "Reduced motion removes extra root jumping")
	_check(reduced_actor.get_node("Figure").rotation.x == 0, "Reduced motion removes extra body tilt")
	game._tick(0.36)
	_command({"type": "effects", "enabled": true, "reducedMotion": false})
	for i in range(200):
		game.combat_fx.impact(game._board_point(5, 4), "cannon", "red", Vector3.FORWARD)
	var capped: Dictionary = game.combat_fx.diagnostics()
	_check(capped.activeParticles <= capped.capacity, "Repeated impacts respect the particle pool's fixed capacity")
	game._tick(8.0)
	var settled: Dictionary = game.combat_fx.diagnostics()
	_check(settled.activeParticles == 0 and settled.activeRings == 0 and not settled.projectileVisible, "Large deterministic advances leave no leaked particles, rings or projectile")
	print("COMBAT_SMOKE_OK: distinct seven-piece movement, exact captures, imported thrust, reset poses, bounded effects, expiration and reduced motion" if failures.is_empty() else "COMBAT_SMOKE_FAILED: " + JSON.stringify(failures))
	game.queue_free()
	await process_frame
	quit(0 if failures.is_empty() else 1)
