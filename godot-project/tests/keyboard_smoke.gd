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

func _cursor(row: int, col: int) -> void:
	_command({"type": "cursor", "row": row, "col": col, "visible": true})

func _at(row: int, col: int, message: String) -> void:
	_check(game.cursor_row == row and game.cursor_col == col, message)
	_check(game.keyboard_cursor.position.distance_to(Vector3((col - 4) * 2.6, 0.515, (row - 4.5) * 2.6)) < 0.001, "Cursor frame must follow its board square")

func _run() -> void:
	game = load("res://main.tscn").instantiate()
	root.add_child(game)
	await process_frame
	_check(not game.keyboard_cursor.visible, "Mouse-first opening must not show a keyboard frame")
	_check(game.keyboard_cursor.multimesh.instance_count == 8, "Keyboard frame retains all corner strokes")
	for view in ["iso", "top", "front"]:
		_command({"type": "camera", "view": view})
		_cursor(6, 4)
		_command({"type": "cursor_step", "dx": 0, "dy": -1})
		_at(5, 4, view + ": Up must move toward the screen top")
		_command({"type": "cursor_step", "dx": 1, "dy": 0})
		_at(5, 5, view + ": Right must move toward the screen right")
	_command({"type": "camera", "view": "side"})
	_cursor(6, 4)
	_command({"type": "cursor_step", "dx": 0, "dy": -1})
	_at(6, 3, "Side view Up must follow the rotated screen, not the original rank")
	_command({"type": "cursor_step", "dx": 1, "dy": 0})
	_at(5, 3, "Side view Right must follow the rotated screen")
	_command({"type": "camera", "view": "top"})
	_cursor(0, 0)
	for i in range(4):
		_command({"type": "cursor_step", "dx": 0, "dy": -1})
		_command({"type": "cursor_step", "dx": -1, "dy": 0})
	_at(0, 0, "Boundary navigation must neither wrap nor turn a corner")
	_cursor(-12, 20)
	_at(0, 8, "Cursor commands clamp to the playable board")
	for i in range(50):
		_command({"type": "zoom", "amount": -1})
	_check(is_equal_approx(game.camera_distance, 24), "Keyboard zoom-in obeys the existing minimum")
	for i in range(50):
		_command({"type": "zoom", "amount": 1})
	_check(is_equal_approx(game.camera_distance, 65), "Keyboard zoom-out obeys the existing maximum")
	_cursor(6, 0)
	var before: Dictionary = game._initial_state()
	var after := before.duplicate(true)
	for piece in after.pieces:
		if piece.id == 23:
			piece.row = 5
	_command({"type": "move", "before": before, "after": after, "move": {"pieceId": 23, "from": {"row": 6, "col": 0}, "to": {"row": 5, "col": 0}, "capturedId": null}})
	_command({"type": "cursor_step", "dx": 1, "dy": 0})
	_at(6, 0, "An in-progress move blocks cursor travel")
	_command({"type": "advance", "ms": 500})
	_command({"type": "cursor_step", "dx": 1, "dy": 0})
	_at(6, 1, "Cursor navigation resumes after the move")
	_command({"type": "cursor", "visible": false})
	_check(not game.keyboard_cursor.visible, "Focus loss can hide the frame without changing position")
	_at(6, 1, "Hiding the cursor preserves its board position")
	print("KEYBOARD_SMOKE_OK" if failures.is_empty() else "KEYBOARD_SMOKE_FAILED: " + JSON.stringify(failures))
	game.queue_free()
	await process_frame
	quit(0 if failures.is_empty() else 1)
