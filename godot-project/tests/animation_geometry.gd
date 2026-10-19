extends SceneTree

var game

func _initialize() -> void:
	call_deferred("_run")

func _skeleton(node: Node) -> Skeleton3D:
	if node is Skeleton3D:
		return node
	for child in node.get_children():
		var found := _skeleton(child)
		if found:
			return found
	return null

func _meshes(node: Node, output: Array) -> void:
	if node is MeshInstance3D and node.skin:
		output.append(node)
	for child in node.get_children():
		_meshes(child, output)

func _vec(value: Vector3) -> Array:
	return [value.x, value.y, value.z]

func _geometry(actor: Node3D, direction: Vector3) -> Dictionary:
	var skeleton := _skeleton(actor)
	skeleton.force_update_all_bone_transforms()
	var spear: Transform3D = skeleton.global_transform * skeleton.get_bone_global_pose(skeleton.find_bone("Spear"))
	var output := {"actor": _vec(actor.global_position), "spearBone": _vec(spear.origin), "meshBindings": []}
	var meshes: Array = []
	_meshes(actor, meshes)
	var max_projection := -INF
	var spear_tip := Vector3.ZERO
	for mesh in meshes:
		var skin: Skin = mesh.skin
		output.meshBindings.append({"node": str(mesh.get_path()), "skeletonPath": str(mesh.skeleton), "resolvedSkeleton": str(mesh.get_node(mesh.skeleton).get_path()), "bindCount": skin.get_bind_count(), "surfaceCount": mesh.mesh.get_surface_count()})
		var skin_transforms: Array[Transform3D] = []
		for index in range(skin.get_bind_count()):
			var bone: int = skin.get_bind_bone(index)
			if bone < 0:
				bone = skeleton.find_bone(skin.get_bind_name(index))
			skin_transforms.append(skeleton.global_transform * skeleton.get_bone_global_pose(bone) * skin.get_bind_pose(index))
		for surface in range(mesh.mesh.get_surface_count()):
			var arrays: Array = mesh.mesh.surface_get_arrays(surface)
			var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
			var bones: PackedInt32Array = arrays[Mesh.ARRAY_BONES]
			var weights: PackedFloat32Array = arrays[Mesh.ARRAY_WEIGHTS]
			var influences: int = bones.size() / vertices.size()
			for vertex in range(vertices.size()):
				var posed := Vector3.ZERO
				var spear_weight := 0.0
				for influence in range(influences):
					var offset := vertex * influences + influence
					posed += (skin_transforms[bones[offset]] * vertices[vertex]) * weights[offset]
					var bone: int = skin.get_bind_bone(bones[offset])
					if bone < 0:
						bone = skeleton.find_bone(skin.get_bind_name(bones[offset]))
					if skeleton.get_bone_name(bone) == "Spear":
						spear_weight += weights[offset]
				if spear_weight > 0.5 and posed.dot(direction) > max_projection:
					max_projection = posed.dot(direction)
					spear_tip = posed
	output.spearTip = _vec(spear_tip)
	return output

func _run() -> void:
	game = load("res://main.tscn").instantiate()
	root.add_child(game)
	await process_frame
	var before := {"pieces": [
		{"id": 1, "type": "general", "color": "red", "row": 9, "col": 4},
		{"id": 2, "type": "general", "color": "black", "row": 0, "col": 3},
		{"id": 3, "type": "soldier", "color": "red", "row": 6, "col": 0},
		{"id": 4, "type": "soldier", "color": "black", "row": 5, "col": 0}], "turn": "red"}
	var after: Dictionary = before.duplicate(true)
	after.pieces = after.pieces.filter(func(piece): return piece.id != 4)
	after.pieces[2].row = 5
	game.manual_clock = true
	game._begin_move({"before": before, "after": after, "move": {"pieceId": 3, "from": {"row": 6, "col": 0}, "to": {"row": 5, "col": 0}, "capturedId": 4}})
	var actor: Node3D = game.piece_nodes[3]
	var direction := Vector3(0, 0, -1)
	var rest := _geometry(actor, direction)
	game._tick(0.58)
	var impact := _geometry(actor, direction)
	print("ANIMATION_GEOMETRY: ", JSON.stringify({"rest": rest, "impact": impact, "targetCenter": _vec(game._board_point(5, 0, 1.5)), "direction": _vec(direction)}))
	quit()
