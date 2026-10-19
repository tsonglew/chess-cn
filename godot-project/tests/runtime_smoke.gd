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

func _check_pedestals(expected_total: int, phase: String) -> void:
	var actual_total := 0
	var actual_batches := 0
	for color in ["red", "black"]:
		var expected_nodes: Array = game.piece_nodes.values().filter(func(node): return node.is_visible_in_tree() and node.get_meta("piece").color == color)
		for layer in ["edge", "top"]:
			var instance: MultiMeshInstance3D = game.get_node("Pedestals_%s_%s" % [color, layer])
			var batch: MultiMesh = instance.multimesh
			actual_batches += 1
			_check(batch.visible_instance_count == expected_nodes.size(), "%s: %s %s must contain exactly the visible team's bases" % [phase, color, layer])
			if layer == "edge":
				actual_total += batch.visible_instance_count
				_check(instance.cast_shadow == GeometryInstance3D.SHADOW_CASTING_SETTING_ON, "Pedestal edges must retain their grounding shadows")
			else:
				_check(instance.cast_shadow == GeometryInstance3D.SHADOW_CASTING_SETTING_OFF, "Pedestal paint tops must not duplicate the edge shadow draws")
			# Godot's headless dummy renderer discards MultiMesh transforms. The
			# native Compatibility run exercises this readback against real data.
			if DisplayServer.get_name() == "headless":
				continue
			var actual_positions: Array[Vector3] = []
			for index in range(batch.visible_instance_count):
				var transform: Transform3D = batch.get_instance_transform(index)
				actual_positions.append((instance.global_transform * transform).origin)
			for node in expected_nodes:
				var expected_position: Vector3 = node.global_transform * Vector3(0, 0.19 if layer == "top" else 0.0, 0)
				var matching_index := -1
				for index in range(actual_positions.size()):
					if actual_positions[index].distance_to(expected_position) < 0.0001:
						matching_index = index
						break
				_check(matching_index >= 0, "%s: %s %s must follow piece %s's actual world position, including lift and rotation" % [phase, color, layer, node.get_meta("piece").id])
				if matching_index >= 0:
					actual_positions.remove_at(matching_index)
	_check(actual_batches == 4, phase + ": pedestal render nodes must remain four shared batches")
	_check(actual_total == expected_total, "%s: expected %d visible pedestals, got %d" % [phase, expected_total, actual_total])

func _run() -> void:
	game = load("res://main.tscn").instantiate()
	root.add_child(game)
	await process_frame
	_check(game.piece_nodes.size() == 32, "Opening position must have 32 visual pieces")
	_check_pedestals(32, "Opening")
	var pedestal_ids: Array = []
	for color in ["red", "black"]:
		for layer in ["edge", "top"]:
			pedestal_ids.append(game.get_node("Pedestals_%s_%s" % [color, layer]).get_instance_id())
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
	_check_pedestals(4, "Demo with reused identities")
	game.pieces_root.position = Vector3(0.35, 0.2, -0.4)
	game.pieces_root.rotation = Vector3(0.06, 0.15, -0.02)
	game._tick(0)
	_check_pedestals(4, "Transformed piece parent")
	game.pieces_root.transform = Transform3D.IDENTITY
	game._tick(0)
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
	game._tick(0.15)
	_check(actor.position.y > game.PIECE_Y + 0.1, "Thrust approach must lift the attacker before the contact phase")
	_check_pedestals(4, "Airborne thrust")
	game._tick(0.416)
	_check(game.piece_nodes[4].visible, "Captured piece must remain visible before impact")
	_check_pedestals(4, "Before impact")
	game._tick(0.017)
	_check(not game.piece_nodes[4].visible, "Captured piece must disappear at the imported thrust impact")
	_check_pedestals(3, "Impact")
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
	_check_pedestals(3, "Completed capture")
	game._sync_state({"state": before})
	_check_pedestals(4, "Undo capture")
	game._sync_state({"state": {"pieces": [pieces[0]], "turn": "red"}})
	_check_pedestals(1, "Empty black side")
	game._sync_state({"state": opening})
	_check(game.piece_nodes.size() == 32, "Restart must restore all 32 pieces")
	_check_pedestals(32, "Restart")
	var restored_ids: Array = []
	for color in ["red", "black"]:
		for layer in ["edge", "top"]:
			restored_ids.append(game.get_node("Pedestals_%s_%s" % [color, layer]).get_instance_id())
	_check(restored_ids == pedestal_ids, "Shared pedestal batches must survive capture, undo, empty-team states, and restart")
	_check(game.piece_nodes[3].get_meta("piece").type == "horse", "Restart must replace the reused soldier ID with its original horse")
	_check(not game.piece_nodes[3].has_meta("animation_player"), "Restart must not retain soldier animation on a horse")
	await process_frame
	if failures.is_empty():
		print("RUNTIME_SMOKE_OK: 32-piece reset, model identity replacement, imported 20-bone thrust, impact timing, travel, and four pedestal batches following visibility")
		print("PEDESTAL_WORLD_POSITIONS: ", "SKIPPED (headless dummy renderer; run native Compatibility for transform readback)" if DisplayServer.get_name() == "headless" else "PASSED (actual MultiMesh transform readback)")
	else:
		print("RUNTIME_SMOKE_FAILED: ", JSON.stringify(failures))
	quit(0 if failures.is_empty() else 1)
