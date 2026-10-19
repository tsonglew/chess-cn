extends SceneTree

var game
var failures: Array[String] = []

func _initialize() -> void:
	call_deferred("_run")

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures.append(message)
		push_error(message)

func _rotation(bones: Dictionary, name: String) -> Quaternion:
	for pose in bones.poses:
		if pose.name == name:
			return Quaternion(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3])
	return Quaternion.IDENTITY

func _global_bone_position(node: Node, bone_name: String) -> Vector3:
	if node is Skeleton3D:
		var index: int = node.find_bone(bone_name)
		if index >= 0:
			return node.global_transform * node.get_bone_global_pose(index).origin
	for child in node.get_children():
		var position := _global_bone_position(child, bone_name)
		if position != Vector3.INF:
			return position
	return Vector3.INF

func _run() -> void:
	game = load("res://main.tscn").instantiate()
	root.add_child(game)
	await process_frame
	_check(game.piece_nodes.size() == 32, "Opening position must have 32 visual pieces")
	var board_lines: MultiMeshInstance3D = game.get_node("BoardLines")
	_check(board_lines.multimesh.instance_count == 126, "All 126 board strokes must be present in the shared mesh batch")
	_check(board_lines.cast_shadow == GeometryInstance3D.SHADOW_CASTING_SETTING_OFF, "Board strokes must not submit shadow draws")
	var opening = game._initial_state()
	var pieces: Array = [
		{"id": 1, "type": "general", "color": "red", "row": 9, "col": 4},
		{"id": 2, "type": "general", "color": "black", "row": 0, "col": 3},
		{"id": 3, "type": "soldier", "color": "red", "row": 6, "col": 0},
		{"id": 4, "type": "soldier", "color": "black", "row": 5, "col": 0}
	]
	var before := {"pieces": pieces, "turn": "red"}
	game._on_command([JSON.stringify({"type": "sync", "state": before, "config": {"testMode": true}})])
	_check(game.manual_clock, "Test mode must stop automatic animation advancement")
	_check(game.piece_nodes.size() == 4, "Demo must replace the opening position")
	var actor: Node3D = game.piece_nodes[3]
	_check(actor.has_meta("animation_player"), "Reused ID must replace its old model with the soldier rig")
	_check(actor.get_meta("animation_clip", "") == "SoldierThrust", "Soldier must use the imported clip")
	var rest: Dictionary = game._bone_sample(actor)
	var spear_rest := _global_bone_position(actor, "Spear")
	var actor_rest := actor.global_position
	_check(rest.get("count", 0) == 20, "Soldier must retain all 20 imported bones")
	var after: Dictionary = before.duplicate(true)
	after.pieces = after.pieces.filter(func(piece): return piece.id != 4)
	after.pieces[2].row = 5
	after.turn = "black"
	game._begin_move({"before": before, "after": after, "move": {"pieceId": 3, "from": {"row": 6, "col": 0}, "to": {"row": 5, "col": 0}, "capturedId": 4}})
	game._tick(0.566)
	_check(game.piece_nodes[4].visible, "Captured piece must remain visible before impact")
	game._tick(0.017)
	_check(not game.piece_nodes[4].visible, "Captured piece must disappear at the imported thrust impact")
	var impact: Dictionary = game._bone_sample(actor)
	_check(_rotation(rest, "UpperArmR").angle_to(_rotation(impact, "UpperArmR")) > 0.05, "Imported arm bones must actually change between rest and impact")
	_check(spear_rest.distance_to(_global_bone_position(actor, "Spear")) > 0.03, "Imported arm animation must move the attached spear bone")
	var direction := Vector3(0, 0, -1)
	var spear_impact := _global_bone_position(actor, "Spear")
	_check((spear_impact - spear_rest).dot(direction) > 0, "Spear motion must point toward the target square")
	_check(((spear_impact - actor.global_position) - (spear_rest - actor_rest)).dot(direction) > 0.05, "Skeleton motion itself must thrust toward the target, independently of board travel")
	game._tick(0.617)
	_check(game.active_move.is_empty(), "Thrust must finish at 1.2 seconds")
	_check(game.piece_nodes.size() == 3, "Captured visual must be removed after completion")
	_check(actor.position.distance_to(game._board_point(5, 0)) < 0.001, "Attacker must finish on the target square")
	game._sync_state({"state": opening})
	_check(game.piece_nodes.size() == 32, "Restart must restore all 32 pieces")
	_check(game.piece_nodes[3].get_meta("piece").type == "horse", "Restart must replace the reused soldier ID with its original horse")
	_check(not game.piece_nodes[3].has_meta("animation_player"), "Restart must not retain soldier animation on a horse")
	await process_frame
	if failures.is_empty():
		print("RUNTIME_SMOKE_OK: 32-piece reset, model identity replacement, imported 20-bone thrust, impact timing and travel")
	else:
		print("RUNTIME_SMOKE_FAILED: ", JSON.stringify(failures))
	quit(0 if failures.is_empty() else 1)
