const SDL_BUTTON_LEFT = 1;
const SDL_BUTTON_MIDDLE = 2;
const SDL_BUTTON_RIGHT = 3;
const SDLK_LEFTBRACKET = 91;
const SDLK_RIGHTBRACKET = 93;
const SDLK_RSHIFT = 303;
const SDLK_LSHIFT = 304;
const SDLK_RCTRL = 305;
const SDLK_LCTRL = 306;
const SDLK_RALT = 307;
const SDLK_LALT = 308;
// TODO: these constants should be defined somewhere else instead, in
// case any other code wants to use them too

const ACTION_NONE = 0;
const ACTION_GARRISON = 1;
const ACTION_REPAIR = 2;
const ACTION_GUARD = 3;
const ACTION_PATROL = 4;
var preSelectedAction = ACTION_NONE;

const INPUT_NORMAL = 0;
const INPUT_SELECTING = 1;
const INPUT_BANDBOXING = 2;
const INPUT_BUILDING_PLACEMENT = 3;
const INPUT_BUILDING_CLICK = 4;
const INPUT_BUILDING_DRAG = 5;
const INPUT_BATCHTRAINING = 6;
const INPUT_PRESELECTEDACTION = 7;
const INPUT_BUILDING_WALL_CLICK = 8;
const INPUT_BUILDING_WALL_PATHING = 9;
const INPUT_MASSTRIBUTING = 10;

var inputState = INPUT_NORMAL;

const INVALID_ENTITY = 0;

var mouseX = 0;
var mouseY = 0;
var mouseIsOverObject = false;

// Number of pixels the mouse can move before the action is considered a drag
var maxDragDelta = 4;

// Store the clicked entity on mousedown or mouseup
var clickedEntity = 0;

// Same double-click behaviour for hotkey presses
const doublePressTime = 500;
var doublePressTimer = 0;
var prevHotkey = 0;

function updateCursorAndTooltip()
{
	var cursorSet = false;
	var tooltipSet = false;
	var informationTooltip = Engine.GetGUIObjectByName("informationTooltip");
	if (!mouseIsOverObject && (inputState == INPUT_NORMAL || inputState == INPUT_PRESELECTEDACTION))
	{
		let action = determineAction(mouseX, mouseY);
		if (action)
		{
			if (action.cursor)
			{
				Engine.SetCursor(action.cursor);
				cursorSet = true;
			}
			if (action.tooltip)
			{
				tooltipSet = true;
				informationTooltip.caption = action.tooltip;
				informationTooltip.hidden = false;
			}
		}
	}

	if (!cursorSet)
		Engine.ResetCursor();

	if (!tooltipSet)
		informationTooltip.hidden = true;

	var placementTooltip = Engine.GetGUIObjectByName("placementTooltip");
	if (placementSupport.tooltipMessage)
		placementTooltip.sprite = placementSupport.tooltipError ? "BackgroundErrorTooltip" : "BackgroundInformationTooltip";

	placementTooltip.caption = placementSupport.tooltipMessage || "";
	placementTooltip.hidden = !placementSupport.tooltipMessage;
}

function updateBuildingPlacementPreview()
{
	// The preview should be recomputed every turn, so that it responds to obstructions/fog/etc moving underneath it, or
	// in the case of the wall previews, in response to new tower foundations getting constructed for it to snap to.
	// See onSimulationUpdate in session.js.

	if (placementSupport.mode === "building")
	{
		if (placementSupport.template && placementSupport.position)
		{
			var result = Engine.GuiInterfaceCall("SetBuildingPlacementPreview", {
				"template": placementSupport.template,
				"x": placementSupport.position.x,
				"z": placementSupport.position.z,
				"angle": placementSupport.angle,
				"actorSeed": placementSupport.actorSeed
			});

			// Show placement info tooltip if invalid position
			placementSupport.tooltipError = !result.success;
			placementSupport.tooltipMessage = "";

			if (!result.success)
			{
				if (result.message && result.parameters)
				{
					var message = result.message;
					if (result.translateMessage)
						if (result.pluralMessage)
							message = translatePlural(result.message, result.pluralMessage, result.pluralCount);
						else
							message = translate(message);
					var parameters = result.parameters;
					if (result.translateParameters)
						translateObjectKeys(parameters, result.translateParameters);
					placementSupport.tooltipMessage = sprintf(message, parameters);
				}
				return false;
			}

			if (placementSupport.attack && placementSupport.attack.Ranged)
			{
				// building can be placed here, and has an attack
				// show the range advantage in the tooltip
				var cmd = {
					"x": placementSupport.position.x,
					"z": placementSupport.position.z,
					"range": placementSupport.attack.Ranged.maxRange,
					"elevationBonus": placementSupport.attack.Ranged.elevationBonus,
				};
				var averageRange = Math.round(Engine.GuiInterfaceCall("GetAverageRangeForBuildings", cmd) - cmd.range);
				var range = Math.round(cmd.range);
				placementSupport.tooltipMessage = sprintf(translatePlural("Basic range: %(range)s meter", "Basic range: %(range)s meters", range), { "range": range }) + "\n" +
					sprintf(translatePlural("Average bonus range: %(range)s meter", "Average bonus range: %(range)s meters", averageRange), { "range": averageRange });
			}
			return true;
		}
	}
	else if (placementSupport.mode === "wall")
	{
		if (placementSupport.wallSet && placementSupport.position)
		{
			// Fetch an updated list of snapping candidate entities
			placementSupport.wallSnapEntities = Engine.PickSimilarPlayerEntities(
				placementSupport.wallSet.templates.tower,
				placementSupport.wallSnapEntitiesIncludeOffscreen,
				true, // require exact template match
				true  // include foundations
			);

			return Engine.GuiInterfaceCall("SetWallPlacementPreview", {
				"wallSet": placementSupport.wallSet,
				"start": placementSupport.position,
				"end": placementSupport.wallEndPosition,
				"snapEntities": placementSupport.wallSnapEntities,	// snapping entities (towers) for starting a wall segment
			});
		}
	}

	return false;
}

function findGatherType(gatherer, supply)
{
	if (!("resourceGatherRates" in gatherer) || !gatherer.resourceGatherRates || !supply)
		return undefined;
	if (gatherer.resourceGatherRates[supply.type.generic+"."+supply.type.specific])
		return supply.type.specific;
	if (gatherer.resourceGatherRates[supply.type.generic])
		return supply.type.generic;
	return undefined;
}

function getActionInfo(action, target)
{
	var simState = GetSimState();
	var selection = g_Selection.toList();

	// If the selection doesn't exist, no action
	var entState = GetEntityState(selection[0]);
	if (!entState)
		return { "possible": false };

	if (!target) // TODO move these non-target actions to an object like unit_actions.js
	{
		if (action == "set-rallypoint")
		{
			var cursor = "";
			var data = { "command": "walk" };
			if (Engine.HotkeyIsPressed("session.attackmove"))
			{
				data.command = "attack-walk";
				data.targetClasses = Engine.HotkeyIsPressed("session.attackmoveUnit") ? { "attack": ["Unit"] } : { "attack": ["Unit", "Structure"] };
				cursor = "action-attack-move";
			}
			else if (Engine.HotkeyIsPressed("session.patrol"))
			{
				data.command = "patrol";
				data.targetClasses = { "attack": g_PatrolTargets };
				cursor = "action-patrol";
			}
			return { "possible": true, "data": data, "cursor": cursor };
		}

		return { "possible": ["move", "attack-move", "remove-guard", "patrol"].indexOf(action) > -1 };
	}

	// Look at the first targeted entity
	// (TODO: maybe we eventually want to look at more, and be more context-sensitive?
	// e.g. prefer to attack an enemy unit, even if some friendly units are closer to the mouse)
	var targetState = GetExtendedEntityState(target);

	// Check if the target entity is a resource, dropsite, foundation, or enemy unit.
	// Check if any entities in the selection can gather the requested resource,
	// can return to the dropsite, can build the foundation, or can attack the enemy
	for (let entityID of selection)
	{
		var entState = GetExtendedEntityState(entityID);
		if (!entState)
			continue;

		if (unitActions[action] && unitActions[action].getActionInfo)
		{
			var r = unitActions[action].getActionInfo(entState, targetState, simState);
			if (r && r.possible) // return true if it's possible for one of the entities
				return r;
		}
	}
	return { "possible": false };
}

/**
 * Determine the context-sensitive action that should be performed when the mouse is at (x,y)
 */
function determineAction(x, y, fromMinimap)
{
	var selection = g_Selection.toList();

	// No action if there's no selection
	if (!selection.length)
	{
		preSelectedAction = ACTION_NONE;
		return undefined;
	}

	// If the selection doesn't exist, no action
	var entState = GetEntityState(selection[0]);
	if (!entState)
		return undefined;

	// If the selection isn't friendly units, no action
	var allOwnedByPlayer = selection.every(ent => {
		var entState = GetEntityState(ent);
		return entState && entState.player == g_ViewedPlayer;
	});

	if (!g_DevSettings.controlAll && !allOwnedByPlayer)
		return undefined;

	var target = undefined;
	if (!fromMinimap)
	{
		var ent = Engine.PickEntityAtPoint(x, y);
		if (ent != INVALID_ENTITY)
			target = ent;
	}

	// decide between the following ordered actions
	// if two actions are possible, the first one is taken
	// so the most specific should appear first
	var actions = Object.keys(unitActions).slice();
	actions.sort((a, b) => unitActions[a].specificness - unitActions[b].specificness);

	var actionInfo = undefined;
	if (preSelectedAction != ACTION_NONE)
	{
		for (var action of actions)
			if (unitActions[action].preSelectedActionCheck)
			{
				var r = unitActions[action].preSelectedActionCheck(target, selection);
				if (r)
					return r;
			}

		return { "type": "none", "cursor": "", "target": target };
	}

	for (var action of actions)
		if (unitActions[action].hotkeyActionCheck)
		{
			var r = unitActions[action].hotkeyActionCheck(target, selection);
			if (r)
				return r;
		}

	for (var action of actions)
		if (unitActions[action].actionCheck)
		{
			var r = unitActions[action].actionCheck(target, selection);
			if (r)
				return r;
		}

	return { "type": "none", "cursor": "", "target": target };
}


var dragStart; // used for remembering mouse coordinates at start of drag operations

function tryPlaceBuilding(queued)
{
	if (placementSupport.mode !== "building")
	{
		error("tryPlaceBuilding expected 'building', got '" + placementSupport.mode + "'");
		return false;
	}

	if (!updateBuildingPlacementPreview())
	{
		// invalid location - don't build it
		// TODO: play a sound?
		return false;
	}

	var selection = g_Selection.toList();

	Engine.PostNetworkCommand({
		"type": "construct",
		"template": placementSupport.template,
		"x": placementSupport.position.x,
		"z": placementSupport.position.z,
		"angle": placementSupport.angle,
		"actorSeed": placementSupport.actorSeed,
		"entities": selection,
		"autorepair": true,
		"autocontinue": true,
		"queued": queued
	});
	Engine.GuiInterfaceCall("PlaySound", { "name": "order_repair", "entity": selection[0] });

	if (!queued)
		placementSupport.Reset();
	else
		placementSupport.RandomizeActorSeed();

	return true;
}

function tryPlaceWall(queued)
{
	if (placementSupport.mode !== "wall")
	{
		error("tryPlaceWall expected 'wall', got '" + placementSupport.mode + "'");
		return false;
	}

	var wallPlacementInfo = updateBuildingPlacementPreview(); // entities making up the wall (wall segments, towers, ...)
	if (!(wallPlacementInfo === false || typeof(wallPlacementInfo) === "object"))
	{
		error("Invalid updateBuildingPlacementPreview return value: " + uneval(wallPlacementInfo));
		return false;
	}

	if (!wallPlacementInfo)
		return false;

	var selection = g_Selection.toList();
	var cmd = {
		"type": "construct-wall",
		"autorepair": true,
		"autocontinue": true,
		"queued": queued,
		"entities": selection,
		"wallSet": placementSupport.wallSet,
		"pieces": wallPlacementInfo.pieces,
		"startSnappedEntity": wallPlacementInfo.startSnappedEnt,
		"endSnappedEntity": wallPlacementInfo.endSnappedEnt,
	};

	// make sure that there's at least one non-tower entity getting built, to prevent silly edge cases where the start and end
	// point are too close together for the algorithm to place a wall segment inbetween, and only the towers are being previewed
	// (this is somewhat non-ideal and hardcode-ish)
	var hasWallSegment = false;
	for (let piece of cmd.pieces)
	{
		if (piece.template != cmd.wallSet.templates.tower) // TODO: hardcode-ish :(
		{
			hasWallSegment = true;
			break;
		}
	}

	if (hasWallSegment)
	{
		Engine.PostNetworkCommand(cmd);
		Engine.GuiInterfaceCall("PlaySound", { "name": "order_repair", "entity": selection[0] });
	}

	return true;
}

// Updates the bandbox object with new positions and visibility.
// The coordinates [x0, y0, x1, y1] are returned for further use.
function updateBandbox(bandbox, ev, hidden)
{
	var x0 = dragStart[0];
	var y0 = dragStart[1];
	var x1 = ev.x;
	var y1 = ev.y;
	// normalize the orientation of the rectangle
	if (x0 > x1) { let t = x0; x0 = x1; x1 = t; }
	if (y0 > y1) { let t = y0; y0 = y1; y1 = t; }

	let scale = +Engine.ConfigDB_GetValue("user", "gui.scale");

	bandbox.size = [x0 * scale, y0 * scale, x1 * scale, y1 * scale].join(" ");
	bandbox.hidden = hidden;

	return [x0, y0, x1, y1];
}

// Define some useful unit filters for getPreferredEntities
var unitFilters = {
	"isUnit": entity => {
		var entState = GetEntityState(entity);
		return entState && hasClass(entState, "Unit");
	},
	"isDefensive": entity => {
		var entState = GetEntityState(entity);
		return entState && hasClass(entState, "Defensive");
	},
	"isMilitary": entity => {
		var entState = GetEntityState(entity);
		return entState &&
			g_MilitaryTypes.some(c => hasClass(entState, c));
	},
	"isIdle": entity => {
		var entState = GetEntityState(entity);

		return entState &&
			hasClass(entState, "Unit") &&
			entState.unitAI &&
			entState.unitAI.isIdle &&
			!hasClass(entState, "Domestic");
	},
	"isAnything": entity => {
		return true;
	}
};

// Choose, inside a list of entities, which ones will be selected.
// We may use several entity filters, until one returns at least one element.
function getPreferredEntities(ents)
{
	// Default filters
	var filters = [unitFilters.isUnit, unitFilters.isDefensive, unitFilters.isAnything];

	// Handle hotkeys
	if (Engine.HotkeyIsPressed("selection.milonly"))
		filters = [unitFilters.isMilitary];
	if (Engine.HotkeyIsPressed("selection.idleonly"))
		filters = [unitFilters.isIdle];

	var preferredEnts = [];
	for (var i = 0; i < filters.length; ++i)
	{
		preferredEnts = ents.filter(filters[i]);
		if (preferredEnts.length)
			break;
	}
	return preferredEnts;
}

function handleInputBeforeGui(ev, hoveredObject)
{
	// Capture mouse position so we can use it for displaying cursors,
	// and key states
	switch (ev.type)
	{
	case "mousebuttonup":
	case "mousebuttondown":
	case "mousemotion":
		mouseX = ev.x;
		mouseY = ev.y;
		break;
	}

	// Remember whether the mouse is over a GUI object or not
	mouseIsOverObject = (hoveredObject != null);

	// Close the menu when interacting with the game world
	if (!mouseIsOverObject && (ev.type =="mousebuttonup" || ev.type == "mousebuttondown")
		&& (ev.button == SDL_BUTTON_LEFT || ev.button == SDL_BUTTON_RIGHT))
		closeMenu();

	// State-machine processing:
	//
	// (This is for states which should override the normal GUI processing - events will
	// be processed here before being passed on, and propagation will stop if this function
	// returns true)
	//
	// TODO: it'd probably be nice to have a better state-machine system, with guaranteed
	// entry/exit functions, since this is a bit broken now

	switch (inputState)
	{
	case INPUT_BANDBOXING:
		var bandbox = Engine.GetGUIObjectByName("bandbox");
		switch (ev.type)
		{
		case "mousemotion":
			var rect = updateBandbox(bandbox, ev, false);

			var ents = Engine.PickPlayerEntitiesInRect(rect[0], rect[1], rect[2], rect[3], g_ViewedPlayer);
			var preferredEntities = getPreferredEntities(ents);
			g_Selection.setHighlightList(preferredEntities);

			return false;

		case "mousebuttonup":
			if (ev.button == SDL_BUTTON_LEFT)
			{
				var rect = updateBandbox(bandbox, ev, true);

				// Get list of entities limited to preferred entities
				var ents = getPreferredEntities(Engine.PickPlayerEntitiesInRect(rect[0], rect[1], rect[2], rect[3], g_ViewedPlayer));

				// Remove the bandbox hover highlighting
				g_Selection.setHighlightList([]);

				// Update the list of selected units
				if (Engine.HotkeyIsPressed("selection.add"))
				{
					g_Selection.addList(ents);
				}
				else if (Engine.HotkeyIsPressed("selection.remove"))
				{
					g_Selection.removeList(ents);
				}
				else
				{
					g_Selection.reset();
					g_Selection.addList(ents);
				}

				inputState = INPUT_NORMAL;
				return true;
			}
			else if (ev.button == SDL_BUTTON_RIGHT)
			{
				// Cancel selection
				bandbox.hidden = true;

				g_Selection.setHighlightList([]);

				inputState = INPUT_NORMAL;
				return true;
			}
			break;
		}
		break;

	case INPUT_BUILDING_CLICK:
		switch (ev.type)
		{
		case "mousemotion":
			// If the mouse moved far enough from the original click location,
			// then switch to drag-orientation mode
			var dragDeltaX = ev.x - dragStart[0];
			var dragDeltaY = ev.y - dragStart[1];
			var maxDragDelta = 16;
			if (Math.abs(dragDeltaX) >= maxDragDelta || Math.abs(dragDeltaY) >= maxDragDelta)
			{
				inputState = INPUT_BUILDING_DRAG;
				return false;
			}
			break;

		case "mousebuttonup":
			if (ev.button == SDL_BUTTON_LEFT)
			{
				// If shift is down, let the player continue placing another of the same building
				var queued = Engine.HotkeyIsPressed("session.queue");
				if (tryPlaceBuilding(queued))
				{
					if (queued)
						inputState = INPUT_BUILDING_PLACEMENT;
					else
						inputState = INPUT_NORMAL;
				}
				else
				{
					inputState = INPUT_BUILDING_PLACEMENT;
				}
				return true;
			}
			break;

		case "mousebuttondown":
			if (ev.button == SDL_BUTTON_RIGHT)
			{
				// Cancel building
				placementSupport.Reset();
				inputState = INPUT_NORMAL;
				return true;
			}
			break;
		}
		break;

	case INPUT_BUILDING_WALL_CLICK:
		// User is mid-click in choosing a starting point for building a wall. The build process can still be cancelled at this point
		// by right-clicking; releasing the left mouse button will 'register' the starting point and commence endpoint choosing mode.
		switch (ev.type)
		{
		case "mousebuttonup":
			if (ev.button === SDL_BUTTON_LEFT)
			{
				inputState = INPUT_BUILDING_WALL_PATHING;
				return true;
			}
			break;

		case "mousebuttondown":
			if (ev.button == SDL_BUTTON_RIGHT)
			{
				// Cancel building
				placementSupport.Reset();
				updateBuildingPlacementPreview();

				inputState = INPUT_NORMAL;
				return true;
			}
			break;
		}
		break;

	case INPUT_BUILDING_WALL_PATHING:
		// User has chosen a starting point for constructing the wall, and is now looking to set the endpoint.
		// Right-clicking cancels wall building mode, left-clicking sets the endpoint and builds the wall and returns to
		// normal input mode. Optionally, shift + left-clicking does not return to normal input, and instead allows the
		// user to continue building walls.
		switch (ev.type)
		{
			case "mousemotion":
				placementSupport.wallEndPosition = Engine.GetTerrainAtScreenPoint(ev.x, ev.y);

				// Update the building placement preview, and by extension, the list of snapping candidate entities for both (!)
				// the ending point and the starting point to snap to.
				//
				// TODO: Note that here, we need to fetch all similar entities, including any offscreen ones, to support the case
				// where the snap entity for the starting point has moved offscreen, or has been deleted/destroyed, or was a
				// foundation and has been replaced with a completed entity since the user first chose it. Fetching all towers on
				// the entire map instead of only the current screen might get expensive fast since walls all have a ton of towers
				// in them. Might be useful to query only for entities within a certain range around the starting point and ending
				// points.

				placementSupport.wallSnapEntitiesIncludeOffscreen = true;
				var result = updateBuildingPlacementPreview(); // includes an update of the snap entity candidates

				if (result && result.cost)
				{
					var neededResources = Engine.GuiInterfaceCall("GetNeededResources", { "cost": result.cost });
					placementSupport.tooltipMessage = [
						getEntityCostTooltip(result),
						getNeededResourcesTooltip(neededResources)
					].filter(tip => tip).join("\n");
				}

				break;

			case "mousebuttondown":
				if (ev.button == SDL_BUTTON_LEFT)
				{
					var queued = Engine.HotkeyIsPressed("session.queue");
					if (tryPlaceWall(queued))
					{
						if (queued)
						{
							// continue building, just set a new starting position where we left off
							placementSupport.position = placementSupport.wallEndPosition;
							placementSupport.wallEndPosition = undefined;

							inputState = INPUT_BUILDING_WALL_CLICK;
						}
						else
						{
							placementSupport.Reset();
							inputState = INPUT_NORMAL;
						}
					}
					else
						placementSupport.tooltipMessage = translate("Cannot build wall here!");

					updateBuildingPlacementPreview();
					return true;
				}
				else if (ev.button == SDL_BUTTON_RIGHT)
				{
					// reset to normal input mode
					placementSupport.Reset();
					updateBuildingPlacementPreview();

					inputState = INPUT_NORMAL;
					return true;
				}
				break;
		}
		break;

	case INPUT_BUILDING_DRAG:
		switch (ev.type)
		{
		case "mousemotion":
			var dragDeltaX = ev.x - dragStart[0];
			var dragDeltaY = ev.y - dragStart[1];
			var maxDragDelta = 16;
			if (Math.abs(dragDeltaX) >= maxDragDelta || Math.abs(dragDeltaY) >= maxDragDelta)
			{
				// Rotate in the direction of the mouse
				var target = Engine.GetTerrainAtScreenPoint(ev.x, ev.y);
				placementSupport.angle = Math.atan2(target.x - placementSupport.position.x, target.z - placementSupport.position.z);
			}
			else
			{
				// If the mouse is near the center, snap back to the default orientation
				placementSupport.SetDefaultAngle();
			}

			var snapData = Engine.GuiInterfaceCall("GetFoundationSnapData", {
				"template": placementSupport.template,
				"x": placementSupport.position.x,
				"z": placementSupport.position.z
			});
			if (snapData)
			{
				placementSupport.angle = snapData.angle;
				placementSupport.position.x = snapData.x;
				placementSupport.position.z = snapData.z;
			}

			updateBuildingPlacementPreview();
			break;

		case "mousebuttonup":
			if (ev.button == SDL_BUTTON_LEFT)
			{
				// If shift is down, let the player continue placing another of the same building
				var queued = Engine.HotkeyIsPressed("session.queue");
				if (tryPlaceBuilding(queued))
				{
					if (queued)
						inputState = INPUT_BUILDING_PLACEMENT;
					else
						inputState = INPUT_NORMAL;
				}
				else
				{
					inputState = INPUT_BUILDING_PLACEMENT;
				}
				return true;
			}
			break;

		case "mousebuttondown":
			if (ev.button == SDL_BUTTON_RIGHT)
			{
				// Cancel building
				placementSupport.Reset();
				inputState = INPUT_NORMAL;
				return true;
			}
			break;
		}
		break;

	case INPUT_MASSTRIBUTING:
		if (ev.type == "hotkeyup" && ev.hotkey == "session.masstribute")
		{
			g_FlushTributing();
			inputState = INPUT_NORMAL;
		}
		break;

	case INPUT_BATCHTRAINING:
		if (ev.type == "hotkeyup" && ev.hotkey == "session.batchtrain")
		{
			flushTrainingBatch();
			inputState = INPUT_NORMAL;
		}
		break;
	}

	return false;
}

function handleInputAfterGui(ev)
{
	if (ev.hotkey === undefined)
		ev.hotkey = null;

	// Handle the time-warp testing features, restricted to single-player
	if (!g_IsNetworked && Engine.GetGUIObjectByName("devTimeWarp").checked)
	{
		if (ev.type == "hotkeydown" && ev.hotkey == "session.timewarp.fastforward")
			Engine.SetSimRate(20.0);
		else if (ev.type == "hotkeyup" && ev.hotkey == "session.timewarp.fastforward")
			Engine.SetSimRate(1.0);
		else if (ev.type == "hotkeyup" && ev.hotkey == "session.timewarp.rewind")
			Engine.RewindTimeWarp();
	}

	if (ev.hotkey == "session.showstatusbars")
	{
		g_ShowAllStatusBars = (ev.type == "hotkeydown");
		recalculateStatusBarDisplay();
	}
	else if (ev.hotkey == "session.highlightguarding")
	{
		g_ShowGuarding = (ev.type == "hotkeydown");
		updateAdditionalHighlight();
	}
	else if (ev.hotkey == "session.highlightguarded")
	{
		g_ShowGuarded = (ev.type == "hotkeydown");
		updateAdditionalHighlight();
	}

	// State-machine processing:

	switch (inputState)
	{
	case INPUT_NORMAL:
		switch (ev.type)
		{
		case "mousemotion":
			// Highlight the first hovered entity (if any)
			var ent = Engine.PickEntityAtPoint(ev.x, ev.y);
			if (ent != INVALID_ENTITY)
				g_Selection.setHighlightList([ent]);
			else
				g_Selection.setHighlightList([]);

			return false;

		case "mousebuttondown":
			if (ev.button == SDL_BUTTON_LEFT)
			{
				dragStart = [ ev.x, ev.y ];
				inputState = INPUT_SELECTING;
				// If a single click occured, reset the clickedEntity.
				// Also set it if we're double/triple clicking and missed the unit earlier.
				if (ev.clicks == 1 || clickedEntity == INVALID_ENTITY)
					clickedEntity = Engine.PickEntityAtPoint(ev.x, ev.y);
				return true;
			}
			else if (ev.button == SDL_BUTTON_RIGHT)
			{
				var action = determineAction(ev.x, ev.y);
				if (!action)
					break;
				return doAction(action, ev);
			}
			break;

		case "hotkeydown":
				if (ev.hotkey.indexOf("selection.group.") == 0)
				{
					var now = new Date();
					if ((now.getTime() - doublePressTimer < doublePressTime) && (ev.hotkey == prevHotkey))
					{
						if (ev.hotkey.indexOf("selection.group.select.") == 0)
						{
							var sptr = ev.hotkey.split(".");
							performGroup("snap", sptr[3]);
						}
					}
					else
					{
						var sptr = ev.hotkey.split(".");
						performGroup(sptr[2], sptr[3]);

						doublePressTimer = now.getTime();
						prevHotkey = ev.hotkey;
					}
				}
				break;
		}
		break;

	case INPUT_PRESELECTEDACTION:
		switch (ev.type)
		{
		case "mousemotion":
			// Highlight the first hovered entity (if any)
			var ent = Engine.PickEntityAtPoint(ev.x, ev.y);
			if (ent != INVALID_ENTITY)
				g_Selection.setHighlightList([ent]);
			else
				g_Selection.setHighlightList([]);

			return false;

		case "mousebuttondown":
			if (ev.button == SDL_BUTTON_LEFT && preSelectedAction != ACTION_NONE)
			{
				var action = determineAction(ev.x, ev.y);
				if (!action)
					break;
				if (!Engine.HotkeyIsPressed("session.queue"))
				{
					preSelectedAction = ACTION_NONE;
					inputState = INPUT_NORMAL;
				}
				return doAction(action, ev);
			}
			else if (ev.button == SDL_BUTTON_RIGHT && preSelectedAction != ACTION_NONE)
			{
				preSelectedAction = ACTION_NONE;
				inputState = INPUT_NORMAL;
				break;
			}
			// else
		default:
			// Slight hack: If selection is empty, reset the input state
			if (g_Selection.toList().length == 0)
			{
				preSelectedAction = ACTION_NONE;
				inputState = INPUT_NORMAL;
				break;
			}
		}
		break;

	case INPUT_SELECTING:
		switch (ev.type)
		{
		case "mousemotion":
			// If the mouse moved further than a limit, switch to bandbox mode
			var dragDeltaX = ev.x - dragStart[0];
			var dragDeltaY = ev.y - dragStart[1];

			if (Math.abs(dragDeltaX) >= maxDragDelta || Math.abs(dragDeltaY) >= maxDragDelta)
			{
				inputState = INPUT_BANDBOXING;
				return false;
			}

			var ent = Engine.PickEntityAtPoint(ev.x, ev.y);
			if (ent != INVALID_ENTITY)
				g_Selection.setHighlightList([ent]);
			else
				g_Selection.setHighlightList([]);
			return false;

		case "mousebuttonup":
			if (ev.button == SDL_BUTTON_LEFT)
			{
				if (clickedEntity == INVALID_ENTITY)
					clickedEntity = Engine.PickEntityAtPoint(ev.x, ev.y);
				if (clickedEntity == INVALID_ENTITY)
				{
					if (!Engine.HotkeyIsPressed("selection.add") && !Engine.HotkeyIsPressed("selection.remove"))
					{
						g_Selection.reset();
						resetIdleUnit();
					}
					inputState = INPUT_NORMAL;
					return true;
				}

				// If camera following and we select different unit, stop
				if (Engine.GetFollowedEntity() != clickedEntity)
					Engine.CameraFollow(0);

				var ents = [];
				if (ev.clicks == 1)
					ents = [clickedEntity];
				else
				{
					// Double click or triple click has occurred
					var showOffscreen = Engine.HotkeyIsPressed("selection.offscreen");
					var matchRank = true;
					var templateToMatch;

					// Check for double click or triple click
					if (ev.clicks == 2)
					{
						// Select similar units regardless of rank
						templateToMatch = GetEntityState(clickedEntity).identity.selectionGroupName;
						if (templateToMatch)
							matchRank = false;
						else
							// No selection group name defined, so fall back to exact match
							templateToMatch = GetEntityState(clickedEntity).template;

					}
					else
						// Triple click
						// Select units matching exact template name (same rank)
						templateToMatch = GetEntityState(clickedEntity).template;

					// TODO: Should we handle "control all units" here as well?
					ents = Engine.PickSimilarPlayerEntities(templateToMatch, showOffscreen, matchRank, false);
				}

				// Update the list of selected units
				if (Engine.HotkeyIsPressed("selection.add"))
					g_Selection.addList(ents);
				else if (Engine.HotkeyIsPressed("selection.remove"))
					g_Selection.removeList(ents);
				else
				{
					g_Selection.reset();
					g_Selection.addList(ents);
				}

				inputState = INPUT_NORMAL;
				return true;
			}
			break;
		}
		break;

	case INPUT_BUILDING_PLACEMENT:
		switch (ev.type)
		{
		case "mousemotion":

			placementSupport.position = Engine.GetTerrainAtScreenPoint(ev.x, ev.y);

			if (placementSupport.mode === "wall")
			{
				// Including only the on-screen towers in the next snap candidate list is sufficient here, since the user is
				// still selecting a starting point (which must necessarily be on-screen). (The update of the snap entities
				// itself happens in the call to updateBuildingPlacementPreview below).
				placementSupport.wallSnapEntitiesIncludeOffscreen = false;
			}
			else
			{
				// cancel if not enough resources
				if (placementSupport.template && Engine.GuiInterfaceCall("GetNeededResources", { "cost": GetTemplateData(placementSupport.template).cost }))
				{
					placementSupport.Reset();
					inputState = INPUT_NORMAL;
					return true;
				}

				var snapData = Engine.GuiInterfaceCall("GetFoundationSnapData", {
					"template": placementSupport.template,
					"x": placementSupport.position.x,
					"z": placementSupport.position.z,
				});
				if (snapData)
				{
					placementSupport.angle = snapData.angle;
					placementSupport.position.x = snapData.x;
					placementSupport.position.z = snapData.z;
				}
			}

			updateBuildingPlacementPreview(); // includes an update of the snap entity candidates
			return false; // continue processing mouse motion

		case "mousebuttondown":
			if (ev.button == SDL_BUTTON_LEFT)
			{
				if (placementSupport.mode === "wall")
				{
					var validPlacement = updateBuildingPlacementPreview();
					if (validPlacement !== false)
						inputState = INPUT_BUILDING_WALL_CLICK;
				}
				else
				{
					placementSupport.position = Engine.GetTerrainAtScreenPoint(ev.x, ev.y);
					dragStart = [ ev.x, ev.y ];
					inputState = INPUT_BUILDING_CLICK;
				}
				return true;
			}
			else if (ev.button == SDL_BUTTON_RIGHT)
			{
				// Cancel building
				placementSupport.Reset();
				inputState = INPUT_NORMAL;
				return true;
			}
			break;

		case "hotkeydown":

			var rotation_step = Math.PI / 12; // 24 clicks make a full rotation

			switch (ev.hotkey)
			{
			case "session.rotate.cw":
				placementSupport.angle += rotation_step;
				updateBuildingPlacementPreview();
				break;
			case "session.rotate.ccw":
				placementSupport.angle -= rotation_step;
				updateBuildingPlacementPreview();
				break;
			}
			break;

		}
		break;
	}
	return false;
}

function doAction(action, ev)
{
	if (!controlsPlayer(g_ViewedPlayer))
		return false;

	var selection = g_Selection.toList();

	// If shift is down, add the order to the unit's order queue instead
	// of running it immediately
	var queued = Engine.HotkeyIsPressed("session.queue");
	var target = Engine.GetTerrainAtScreenPoint(ev.x, ev.y);

	if (unitActions[action.type] && unitActions[action.type].execute)
		return unitActions[action.type].execute(target, action, selection, queued);

	error("Invalid action.type " + action.type);
	return false;
}

function handleMinimapEvent(target)
{
	// Partly duplicated from handleInputAfterGui(), but with the input being
	// world coordinates instead of screen coordinates.

	if (inputState != INPUT_NORMAL)
		return false;

	var fromMinimap = true;
	var action = determineAction(undefined, undefined, fromMinimap);
	if (!action)
		return false;

	var selection = g_Selection.toList();

	var queued = Engine.HotkeyIsPressed("session.queue");
	if (unitActions[action.type] && unitActions[action.type].execute)
		return unitActions[action.type].execute(target, action, selection, queued);
	error("Invalid action.type " + action.type);
	return false;
}

// Called by GUI when user clicks construction button
// @param buildTemplate Template name of the entity the user wants to build
function startBuildingPlacement(buildTemplate, playerState)
{
	if(getEntityLimitAndCount(playerState, buildTemplate).canBeAddedCount == 0)
		return;

	// TODO: we should clear any highlight selection rings here. If the mouse was over an entity before going onto the GUI
	// to start building a structure, then the highlight selection rings are kept during the construction of the building.
	// Gives the impression that somehow the hovered-over entity has something to do with the building you're constructing.

	placementSupport.Reset();

	// find out if we're building a wall, and change the entity appropriately if so
	var templateData = GetTemplateData(buildTemplate);
	if (templateData.wallSet)
	{
		placementSupport.mode = "wall";
		placementSupport.wallSet = templateData.wallSet;
		inputState = INPUT_BUILDING_PLACEMENT;
	}
	else
	{
		placementSupport.mode = "building";
		placementSupport.template = buildTemplate;
		inputState = INPUT_BUILDING_PLACEMENT;
	}

	if (templateData.attack &&
		templateData.attack.Ranged &&
		templateData.attack.Ranged.maxRange)
	{
		// add attack information to display a good tooltip
		placementSupport.attack = templateData.attack;
	}
}

// Camera jumping: when the user presses a hotkey the current camera location is marked.
// When they press another hotkey the camera jumps back to that position. If the camera is already roughly at that location,
// jump back to where it was previously.
var jumpCameraPositions = [];
var jumpCameraLast;
var jumpCameraDistanceThreshold = Engine.ConfigDB_GetValue("user", "gui.session.camerajump.threshold");

function jumpCamera(index)
{
	var position = jumpCameraPositions[index];
	if (position)
	{
		if (jumpCameraLast &&
				Math.abs(Engine.CameraGetX() - position.x) < jumpCameraDistanceThreshold &&
				Math.abs(Engine.CameraGetZ() - position.z) < jumpCameraDistanceThreshold)
			Engine.CameraMoveTo(jumpCameraLast.x, jumpCameraLast.z);
		else
		{
			jumpCameraLast = {x: Engine.CameraGetX(), z: Engine.CameraGetZ()};
			Engine.CameraMoveTo(position.x, position.z);
		}
	}
}

function setJumpCamera(index)
{
	jumpCameraPositions[index] = {x: Engine.CameraGetX(), z: Engine.CameraGetZ()};
}

// Batch training:
// When the user shift-clicks, we set these variables and switch to INPUT_BATCHTRAINING
// When the user releases shift, or clicks on a different training button, we create the batched units
var g_BatchTrainingEntities;
var g_BatchTrainingType;
var g_BatchTrainingCount;
var g_BatchTrainingEntityAllowedCount;

function flushTrainingBatch()
{
	var appropriateBuildings = getBuildingsWhichCanTrainEntity(g_BatchTrainingEntities, g_BatchTrainingType);
	// If training limits don't allow us to train g_BatchTrainingCount in each appropriate building
	if (g_BatchTrainingEntityAllowedCount !== undefined &&
		g_BatchTrainingEntityAllowedCount < g_BatchTrainingCount * appropriateBuildings.length)
	{
		// Train as many full batches as we can
		var buildingsCountToTrainFullBatch = Math.floor(g_BatchTrainingEntityAllowedCount / g_BatchTrainingCount);
		var buildingsToTrainFullBatch = appropriateBuildings.slice(0, buildingsCountToTrainFullBatch);
		Engine.PostNetworkCommand({
			"type": "train",
			"entities": buildingsToTrainFullBatch,
			"template": g_BatchTrainingType,
			"count": g_BatchTrainingCount
		});

		// Train remainer in one more building
		Engine.PostNetworkCommand({
			"type": "train",
			"entities": [ appropriateBuildings[buildingsCountToTrainFullBatch] ],
			"template": g_BatchTrainingType,
			"count": g_BatchTrainingEntityAllowedCount % g_BatchTrainingCount
		});
	}
	else
		Engine.PostNetworkCommand({
			"type": "train",
			"entities": appropriateBuildings,
			"template": g_BatchTrainingType,
			"count": g_BatchTrainingCount
		});
}

function getBuildingsWhichCanTrainEntity(entitiesToCheck, trainEntType)
{
	return entitiesToCheck.filter(entity => {
		var state = GetEntityState(entity);
		var canTrain = state && state.production && state.production.entities.length &&
			state.production.entities.indexOf(trainEntType) != -1;
		return canTrain;
	});
}

function getEntityLimitAndCount(playerState, entType)
{
	var r = {
		"entLimit": undefined,
		"entCount": undefined,
		"entLimitChangers": undefined,
		"canBeAddedCount": undefined
	};
	if (!playerState.entityLimits)
		return r;
	var template = GetTemplateData(entType);
	var entCategory = null;
	if (template.trainingRestrictions)
		entCategory = template.trainingRestrictions.category;
	else if (template.buildRestrictions)
		entCategory = template.buildRestrictions.category;
	if (entCategory && playerState.entityLimits[entCategory] !== undefined)
	{
		r.entLimit = playerState.entityLimits[entCategory] || 0;
		r.entCount = playerState.entityCounts[entCategory] || 0;
		r.entLimitChangers = playerState.entityLimitChangers[entCategory];
		r.canBeAddedCount = Math.max(r.entLimit - r.entCount, 0);
	}
	return r;
}

// Add the unit shown at position to the training queue for all entities in the selection
function addTrainingByPosition(position)
{
	var simState = GetSimState();
	var playerState = simState.players[Engine.GetPlayerID()];
	var selection = g_Selection.toList();

	if (!playerState || !selection.length)
		return;

	var trainableEnts = getAllTrainableEntitiesFromSelection();

	// Check if the position is valid
	if (!trainableEnts.length || trainableEnts.length <= position)
		return;

	var entToTrain = trainableEnts[position];

	addTrainingToQueue(selection, entToTrain, playerState);
	return;
}

// Called by GUI when user clicks training button
function addTrainingToQueue(selection, trainEntType, playerState)
{
	// Create list of buildings which can train trainEntType
	var appropriateBuildings = getBuildingsWhichCanTrainEntity(selection, trainEntType);

	// Check trainEntType entity limit and count
	var limits = getEntityLimitAndCount(playerState, trainEntType);

	// Batch training possible if we can train at least 2 units
	var batchTrainingPossible = limits.canBeAddedCount == undefined || limits.canBeAddedCount > 1;

	var decrement = Engine.HotkeyIsPressed("selection.remove");
	if (!decrement)
		var template = GetTemplateData(trainEntType);

	let batchIncrementSize = +Engine.ConfigDB_GetValue("user", "gui.session.batchtrainingsize");

	if (Engine.HotkeyIsPressed("session.batchtrain") && batchTrainingPossible)
	{
		if (inputState == INPUT_BATCHTRAINING)
		{
			// Check if we are training in the same building(s) as the last batch
			var sameEnts = false;
			if (g_BatchTrainingEntities.length == selection.length)
				// NOTE: We just check if the arrays are the same and if the order is the same
				// If the order changed, we have a new selection and we should create a new batch.
				for (let i = 0; i < g_BatchTrainingEntities.length; ++i)
					if (!(sameEnts = g_BatchTrainingEntities[i] == selection[i]))
						break;
			// If we're already creating a batch of this unit (in the same building(s)), then just extend it
			// (if training limits allow)
			if (sameEnts && g_BatchTrainingType == trainEntType)
			{
				if (decrement)
				{
					g_BatchTrainingCount -= batchIncrementSize;
					if (g_BatchTrainingCount <= 0)
						inputState = INPUT_NORMAL;
				}
				else if (limits.canBeAddedCount == undefined ||
					limits.canBeAddedCount > g_BatchTrainingCount * appropriateBuildings.length)
				{
					if (Engine.GuiInterfaceCall("GetNeededResources", { "cost":
						multiplyEntityCosts(template, g_BatchTrainingCount + batchIncrementSize) }))
						return;

					g_BatchTrainingCount += batchIncrementSize;
				}
				g_BatchTrainingEntityAllowedCount = limits.canBeAddedCount;
				return;
			}
			// Otherwise start a new one
			else if (!decrement)
			{
				flushTrainingBatch();
				// fall through to create the new batch
			}
		}

		// Don't start a new batch if decrementing or unable to afford it.
		if (decrement || Engine.GuiInterfaceCall("GetNeededResources", { "cost":
			multiplyEntityCosts(template, batchIncrementSize) }))
			return;

		inputState = INPUT_BATCHTRAINING;
		g_BatchTrainingEntities = selection;
		g_BatchTrainingType = trainEntType;
		g_BatchTrainingEntityAllowedCount = limits.canBeAddedCount;
		g_BatchTrainingCount = batchIncrementSize;
	}
	else
	{
		// Non-batched - just create a single entity in each building
		// (but no more than entity limit allows)
		var buildingsForTraining = appropriateBuildings;
		if (limits.entLimit)
			buildingsForTraining = buildingsForTraining.slice(0, limits.canBeAddedCount);
		Engine.PostNetworkCommand({
			"type": "train",
			"template": trainEntType,
			"count": 1,
			"entities": buildingsForTraining
		});
	}
}

// Called by GUI when user clicks research button
function addResearchToQueue(entity, researchType)
{
	Engine.PostNetworkCommand({ "type": "research", "entity": entity, "template": researchType });
}

/**
 * Returns the number of units that will be present in a batch if the user clicks
 * the training button with shift down
 */
function getTrainingStatus(playerState, trainEntType, selection)
{
	let batchIncrementSize = +Engine.ConfigDB_GetValue("user", "gui.session.batchtrainingsize");
	var appropriateBuildings = [];
	if (selection)
		appropriateBuildings = getBuildingsWhichCanTrainEntity(selection, trainEntType);
	var nextBatchTrainingCount = 0;

	var limits;
	if (inputState == INPUT_BATCHTRAINING && g_BatchTrainingType == trainEntType)
	{
		nextBatchTrainingCount = g_BatchTrainingCount;
		limits = {
			"canBeAddedCount": g_BatchTrainingEntityAllowedCount
		};
	}
	else
		limits = getEntityLimitAndCount(playerState, trainEntType);

	// We need to calculate count after the next increment if it's possible
	if (limits.canBeAddedCount == undefined ||
		limits.canBeAddedCount > nextBatchTrainingCount * appropriateBuildings.length)
		nextBatchTrainingCount += batchIncrementSize;

	// If training limits don't allow us to train batchTrainingCount in each appropriate building
	// train as many full batches as we can and remainer in one more building.
	var buildingsCountToTrainFullBatch = appropriateBuildings.length;
	var remainderToTrain = 0;
	if (limits.canBeAddedCount !== undefined &&
	    limits.canBeAddedCount < nextBatchTrainingCount * appropriateBuildings.length)
	{
		buildingsCountToTrainFullBatch = Math.floor(limits.canBeAddedCount / nextBatchTrainingCount);
		remainderToTrain = limits.canBeAddedCount % nextBatchTrainingCount;
	}

	return [buildingsCountToTrainFullBatch, nextBatchTrainingCount, remainderToTrain];
}

// Called by GUI when user clicks production queue item
function removeFromProductionQueue(entity, id)
{
	Engine.PostNetworkCommand({ "type": "stop-production", "entity": entity, "id": id });
}

// Called by unit selection buttons
function changePrimarySelectionGroup(templateName, deselectGroup)
{
	g_Selection.makePrimarySelection(templateName, Engine.HotkeyIsPressed("session.deselectgroup") || deselectGroup);
}

function performCommand(entState, commandName)
{
	if (!entState)
		return;

	if (!controlsPlayer(entState.player) &&
	    !(g_IsObserver && commandName == "focus-rally"))
		return;

	if (g_EntityCommands[commandName])
		g_EntityCommands[commandName].execute(entState);
}

function performAllyCommand(entity, commandName)
{
	if (!entity)
		return;
	var entState = GetExtendedEntityState(entity);

	var playerState = GetSimState().players[Engine.GetPlayerID()];
	if (!playerState.isMutualAlly[entState.player] || g_IsObserver)
		return;

	if (g_AllyEntityCommands[commandName])
		g_AllyEntityCommands[commandName].execute(entState);
}

function performFormation(entities, formationTemplate)
{
	if (entities)
		Engine.PostNetworkCommand({
			"type": "formation",
			"entities": entities,
			"name": formationTemplate
		});
}

function performGroup(action, groupId)
{
	switch (action)
	{
	case "snap":
	case "select":
	case "add":
		var toSelect = [];
		g_Groups.update();
		for (var ent in g_Groups.groups[groupId].ents)
			toSelect.push(+ent);

		if (action != "add")
			g_Selection.reset();

		g_Selection.addList(toSelect);

		if (action == "snap" && toSelect.length)
		{
			let entState = GetEntityState(toSelect[0]);
			let position = entState.position;
			if (position && entState.visibility != "hidden")
				Engine.CameraMoveTo(position.x, position.z);
		}
		break;
	case "save":
	case "breakUp":
		g_Groups.groups[groupId].reset();

		if (action == "save")
			g_Groups.addEntities(groupId, g_Selection.toList());

		updateGroups();
		break;
	}
}

function performStance(entities, stanceName)
{
	if (entities)
		Engine.PostNetworkCommand({
			"type": "stance",
			"entities": entities,
			"name": stanceName
		});
}

function lockGate(lock)
{
	var selection = g_Selection.toList();
	Engine.PostNetworkCommand({
		"type": "lock-gate",
		"entities": selection,
		"lock": lock,
	});
}

function packUnit(pack)
{
	var selection = g_Selection.toList();
	Engine.PostNetworkCommand({
		"type": "pack",
		"entities": selection,
		"pack": pack,
		"queued": false
	});
}

function cancelPackUnit(pack)
{
	var selection = g_Selection.toList();
	Engine.PostNetworkCommand({
		"type": "cancel-pack",
		"entities": selection,
		"pack": pack,
		"queued": false
	});
}

function upgradeEntity(Template)
{
	Engine.PostNetworkCommand({
		"type": "upgrade",
		"entities": g_Selection.toList(),
		"template": Template,
		"queued": false
	});
}

function cancelUpgradeEntity()
{
	Engine.PostNetworkCommand({
		"type": "cancel-upgrade",
		"entities": g_Selection.toList(),
		"queued": false
	});
}

// Set the camera to follow the given unit
function setCameraFollow(entity)
{
	// Follow the given entity if it's a unit
	if (entity)
	{
		var entState = GetEntityState(entity);
		if (entState && hasClass(entState, "Unit"))
		{
			Engine.CameraFollow(entity);
			return;
		}
	}

	// Otherwise stop following
	Engine.CameraFollow(0);
}

var lastIdleUnit = 0;
var currIdleClassIndex = 0;
var lastIdleClasses = [];

function resetIdleUnit()
{
	lastIdleUnit = 0;
	currIdleClassIndex = 0;
	lastIdleClasses = [];
}

function findIdleUnit(classes)
{
	var append = Engine.HotkeyIsPressed("selection.add");
	var selectall = Engine.HotkeyIsPressed("selection.offscreen");

	// Reset the last idle unit, etc., if the selection type has changed.
	if (selectall || classes.length != lastIdleClasses.length || !classes.every((v,i) => v === lastIdleClasses[i]))
		resetIdleUnit();
	lastIdleClasses = classes;

	var data = {
		"viewedPlayer": g_ViewedPlayer,
		"excludeUnits": append ? g_Selection.toList() : [],
		// If the current idle class index is not 0, put the class at that index first.
		"idleClasses": classes.slice(currIdleClassIndex, classes.length).concat(classes.slice(0, currIdleClassIndex))
	};
	if (!selectall)
	{
		data.limit = 1;
		data.prevUnit = lastIdleUnit;
	}

	var idleUnits = Engine.GuiInterfaceCall("FindIdleUnits", data);
	if (!idleUnits.length)
	{
		// TODO: display a message or play a sound to indicate no more idle units, or something
		// Reset for next cycle
		resetIdleUnit();
		return;
	}

	if (!append)
		g_Selection.reset();
	g_Selection.addList(idleUnits);

	if (selectall)
		return;

	lastIdleUnit = idleUnits[0];
	var entityState = GetEntityState(lastIdleUnit);
	var position = entityState.position;
	if (position)
		Engine.CameraMoveTo(position.x, position.z);
	// Move the idle class index to the first class an idle unit was found for.
	var indexChange = data.idleClasses.findIndex(elem => MatchesClassList(entityState.identity.classes, elem));
	currIdleClassIndex = (currIdleClassIndex + indexChange) % classes.length;
}

function stopUnits(entities)
{
	Engine.PostNetworkCommand({ "type": "stop", "entities": entities, "queued": false });
}

function unload(garrisonHolder, entities)
{
	if (Engine.HotkeyIsPressed("session.unloadtype"))
		Engine.PostNetworkCommand({ "type": "unload", "entities": entities, "garrisonHolder": garrisonHolder });
	else
		Engine.PostNetworkCommand({ "type": "unload", "entities": [entities[0]], "garrisonHolder": garrisonHolder });
}

function unloadTemplate(template, owner)
{
	// Filter out all entities that aren't garrisonable.
	var garrisonHolders = g_Selection.toList().filter(e => {
		var state = GetEntityState(e);
		if (state && state.garrisonHolder)
			return true;
		return false;
	});

	Engine.PostNetworkCommand({
		"type": "unload-template",
		"all": Engine.HotkeyIsPressed("session.unloadtype"),
		"template": template,
		"owner": owner,
		"garrisonHolders": garrisonHolders
	});
}

function unloadSelection()
{
	let parent = 0;
	let ents = [];
	for (let ent in g_Selection.selected)
	{
		let state = GetExtendedEntityState(+ent);
		if (!state || !state.turretParent)
			continue;
		if (!parent)
		{
			parent = state.turretParent;
			ents.push(+ent);
		}
		else if (state.turretParent == parent)
			ents.push(+ent);
	}
	if (parent)
		Engine.PostNetworkCommand({ "type": "unload", "entities": ents, "garrisonHolder": parent });
}

function unloadAllByOwner()
{
	var garrisonHolders = g_Selection.toList().filter(e => {
		var state = GetEntityState(e);
		return state && state.garrisonHolder;
	});
	Engine.PostNetworkCommand({ "type": "unload-all-by-owner", "garrisonHolders": garrisonHolders });
}

function unloadAll()
{
	// Filter out all entities that aren't garrisonable.
	var garrisonHolders = g_Selection.toList().filter(e => {
		var state = GetEntityState(e);
		return state && state.garrisonHolder;
	});

	Engine.PostNetworkCommand({ "type": "unload-all", "garrisonHolders": garrisonHolders });
}

function backToWork()
{
	// Filter out all entities that can't go back to work.
	var workers = g_Selection.toList().filter(e => {
		var state = GetEntityState(e);
		return state && state.unitAI && state.unitAI.hasWorkOrders;
	});

	Engine.PostNetworkCommand({ "type": "back-to-work", "entities": workers });
}

function removeGuard()
{
	// Filter out all entities that are currently guarding/escorting.
	var entities = g_Selection.toList().filter(e => {
		var state = GetEntityState(e);
		return state && state.unitAI && state.unitAI.isGuarding;
	});

	Engine.PostNetworkCommand({ "type": "remove-guard", "entities": entities });
}

function raiseAlert()
{
	let entities = g_Selection.toList().filter(e => {
		let state = GetEntityState(e);
		return state && state.alertRaiser && !state.alertRaiser.hasRaisedAlert;
	});

	Engine.PostNetworkCommand({ "type": "increase-alert-level", "entities": entities });
}

function increaseAlertLevel()
{
	raiseAlert();

	let entities = g_Selection.toList().filter(e => {
		let state = GetEntityState(e);
		return state && state.alertRaiser && state.alertRaiser.canIncreaseLevel;
	});

	Engine.PostNetworkCommand({ "type": "increase-alert-level", "entities": entities });
}

function endOfAlert()
{
	let entities = g_Selection.toList().filter(e => {
		let state = GetEntityState(e);
		return state && state.alertRaiser && state.alertRaiser.hasRaisedAlert;
	});

	Engine.PostNetworkCommand({ "type": "alert-end", "entities": entities });
}

function clearSelection()
{
	if(inputState==INPUT_BUILDING_PLACEMENT || inputState==INPUT_BUILDING_WALL_PATHING)
	{
		inputState = INPUT_NORMAL;
		placementSupport.Reset();
	}
	else
		g_Selection.reset();
	preSelectedAction = ACTION_NONE;
}

