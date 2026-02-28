<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import { useGame, SquareGrid, getTileAt, rotateTileOffsets, type TileRotation } from "@noble/bg-engine/client";
import {
	IconChevronRight,
	IconDiamond,
	IconMountain,
	IconDeer,
	IconWheat,
	IconHexagon,
	IconMeeple,
	IconLock,
	IconCompass,
	IconHammer,
	IconPalette,
	IconSword,
	IconBuildingCastle,
	IconBolt,
	IconFlask,
	IconSunHigh,
	IconLaurelWreath,
	IconCoin,
	IconSquareFilled,
} from "@tabler/icons-vue";

const props = withDefaults(defineProps<{ headerHeight?: number }>(), { headerHeight: 72 });
const emit = defineEmits<{ backToLobby: [] }>();
import {
	gameDef,
	ERA_TILE_SHAPES,
	ROTATIONS,
	PLAYER_COLORS,
	ACTION_TYPES,
	TECH_TREE,
	TECH_COSTS,
	canPlaceGameTile,
	getPlayerTileEdges,
	getMovementRange,
	getReachableCells,
	getUnlockedBuildingSlots,
	getAttackCost,
	INVASION_COSTS,
	getPlayerRankings,
	WONDER_DEFS,
	type GoldenAgesState,
	type CellEdges,
	type BoardPiece,
	type BoardCity,
	type GamePhase,
	type ActionType,
	type BackColor,
	type PlayerColor,
	type ResourceType,
} from "../logic/game-logic";

const { state, playerID, isMyTurn, move } = useGame();

const G = computed(() => state.value as unknown as GoldenAgesState | undefined);

const PASSIVE_BUILDINGS = new Set(["wall"]);

const rotation = ref<TileRotation>(0);

// ---------------------------------------------------------------------------
// Starting tile helpers — render the 2x2 as a single visual block
// ---------------------------------------------------------------------------

function tileIdAt(row: number, col: number): string | undefined {
	if (!G.value?.tiles) return undefined;
	return getTileAt(G.value.tiles, row, col)?.id;
}

function isStartingTile(row: number, col: number): boolean {
	return tileIdAt(row, col) === "starting-tile";
}

function isPlayerTile(row: number, col: number): boolean {
	if (!G.value?.tiles) return false;
	const tile = getTileAt(G.value.tiles, row, col);
	return !!tile && tile.id !== "starting-tile";
}

function tileOwnerColor(row: number, col: number): PlayerColor | null {
	if (!G.value?.tiles) return null;
	const tile = getTileAt(G.value.tiles, row, col);
	if (!tile || !tile.owner) return null;
	const idx = parseInt(tile.owner, 10);
	return PLAYER_COLORS[idx] ?? null;
}

function startingTileBorders(row: number, col: number): string {
	if (!isStartingTile(row, col)) return "";
	const classes: string[] = [];
	if (isStartingTile(row, col - 1)) classes.push("border-l-transparent");
	if (isStartingTile(row, col + 1)) classes.push("border-r-transparent");
	if (isStartingTile(row - 1, col)) classes.push("border-t-transparent");
	if (isStartingTile(row + 1, col)) classes.push("border-b-transparent");
	return classes.join(" ");
}

function isStartingTileLabel(row: number, col: number): boolean {
	return isStartingTile(row, col) && !isStartingTile(row - 1, col) && !isStartingTile(row, col - 1);
}

// ---------------------------------------------------------------------------
// Player tile border merging
// ---------------------------------------------------------------------------

function sameTileNeighbor(row: number, col: number, dr: number, dc: number): boolean {
	const id = tileIdAt(row, col);
	if (!id || id === "starting-tile") return false;
	return tileIdAt(row + dr, col + dc) === id;
}

function playerTileBorders(row: number, col: number): string {
	const classes: string[] = [];
	if (sameTileNeighbor(row, col, 0, -1)) classes.push("border-l-transparent");
	if (sameTileNeighbor(row, col, 0, 1)) classes.push("border-r-transparent");
	if (sameTileNeighbor(row, col, -1, 0)) classes.push("border-t-transparent");
	if (sameTileNeighbor(row, col, 1, 0)) classes.push("border-b-transparent");
	return classes.join(" ");
}

// ---------------------------------------------------------------------------
// Tile placement
// ---------------------------------------------------------------------------

const currentEra = computed(() => G.value?.currentEra ?? "I");
const currentPhase = computed<GamePhase>(() => G.value?.phase ?? "eraStart");
const isEraStart = computed(() => currentPhase.value === "eraStart");
const isTilePlacement = computed(() => currentPhase.value === "tilePlacement");
const isActionPhase = computed(() => currentPhase.value === "actions");

const currentShape = computed(() => {
	return ERA_TILE_SHAPES[currentEra.value];
});

const validAnchors = computed<[number, number][]>(() => {
	if (!isTilePlacement.value) return [];
	if (!G.value?.board || !G.value?.tiles || !currentShape.value || !isMyTurn.value) return [];
	const tileEdges = playerID.value ? getPlayerTileEdges(G.value as GoldenAgesState, playerID.value) : undefined;
	const anchors: [number, number][] = [];
	for (let r = 0; r < G.value.board.rows; r++) {
		for (let c = 0; c < G.value.board.cols; c++) {
			if (
				canPlaceGameTile(
					G.value.tiles,
					G.value.board,
					currentShape.value,
					r,
					c,
					rotation.value,
					(G.value as GoldenAgesState).boardEdges,
					tileEdges
				)
			) {
				anchors.push([r, c]);
			}
		}
	}
	return anchors;
});

const highlightedCells = computed<Set<string>>(() => {
	const set = new Set<string>();
	if (!currentShape.value) return set;
	const rotated = rotateTileOffsets(currentShape.value.offsets, rotation.value);
	for (const [ar, ac] of validAnchors.value) {
		for (const [dr, dc] of rotated) {
			set.add(`${ar + dr},${ac + dc}`);
		}
	}
	return set;
});

const hoverAnchor = ref<[number, number] | null>(null);

const previewCells = computed<Set<string>>(() => {
	const set = new Set<string>();
	if (!hoverAnchor.value || !currentShape.value) return set;
	const [ar, ac] = hoverAnchor.value;
	const rotated = rotateTileOffsets(currentShape.value.offsets, rotation.value);
	for (const [dr, dc] of rotated) {
		set.add(`${ar + dr},${ac + dc}`);
	}
	return set;
});

const cellToAnchor = computed<Map<string, [number, number]>>(() => {
	const map = new Map<string, [number, number]>();
	if (!currentShape.value) return map;
	const rotated = rotateTileOffsets(currentShape.value.offsets, rotation.value);
	for (const anchor of validAnchors.value) {
		for (const [dr, dc] of rotated) {
			map.set(`${anchor[0] + dr},${anchor[1] + dc}`, anchor);
		}
	}
	return map;
});

const pendingPlacement = ref<{ anchor: [number, number]; rotation: TileRotation } | null>(null);

function onCellClick(row: number, col: number) {
	if (activatingFactory.value !== null) {
		const workers = piecesAt(row, col).filter((p) => p.type === "worker" && p.owner === playerID.value && p.exhausted && !p.inAgora);
		if (workers.length > 0) {
			onSelectFactoryWorker(workers[0].id);
		}
		return;
	}

	if (agoraAction.value) {
		const workers = piecesAt(row, col).filter((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted && !p.inAgora);
		if (workers.length > 0) {
			onSelectAgoraWorker(workers[0]);
		}
		return;
	}

	if (soldierPhase.value === "selectDest") {
		const key = `${row},${col}`;
		if (soldierReachableSet.value.has(key)) {
			onSelectSoldierDest(row, col);
		}
		return;
	}

	if (soldierPhase.value === "selectWorker") {
		const workers = piecesAt(row, col).filter((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted);
		if (workers.length > 0) {
			onSelectSoldierWorker(workers[0]);
		}
		return;
	}

	if (explorerPhase.value === "selectDest") {
		const key = `${row},${col}`;
		if (explorerReachableSet.value.has(key)) {
			onSelectExplorerDest(row, col);
		}
		return;
	}

	if (explorerPhase.value === "selectWorker") {
		const workers = piecesAt(row, col).filter((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted);
		if (workers.length > 0) {
			onSelectWorker(workers[0]);
		}
		return;
	}

	if (isMyTurn.value && isActionPhase.value && !myPassedThisEra.value && explorerPhase.value === null && soldierPhase.value === null) {
		const workers = piecesAt(row, col).filter((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted);
		if (workers.length > 0) {
			onStartExplorer();
			return;
		}
	}

	if (!isMyTurn.value || !isTilePlacement.value) return;
	const key = `${row},${col}`;
	const anchor = cellToAnchor.value.get(key);
	if (!anchor) return;

	if (currentEra.value !== "I") {
		pendingPlacement.value = { anchor, rotation: rotation.value };
		return;
	}

	move("placeTile", anchor[0], anchor[1], rotation.value);
	hoverAnchor.value = null;
}

function confirmPlacement(moveCapital: boolean) {
	if (!pendingPlacement.value) return;
	const { anchor, rotation: rot } = pendingPlacement.value;
	pendingPlacement.value = null;
	move("placeTile", anchor[0], anchor[1], rot, moveCapital);
	hoverAnchor.value = null;
}

function cancelPlacement() {
	pendingPlacement.value = null;
}

function onCellHover(row: number, col: number) {
	if (!isMyTurn.value || !isTilePlacement.value) return;
	const key = `${row},${col}`;
	const anchor = cellToAnchor.value.get(key);
	hoverAnchor.value = anchor ?? null;
}

function onCellLeave() {
	hoverAnchor.value = null;
}

function cycleRotation(direction: 1 | -1) {
	const idx = ROTATIONS.indexOf(rotation.value);
	const next = (idx + direction + ROTATIONS.length) % ROTATIONS.length;
	rotation.value = ROTATIONS[next];
	hoverAnchor.value = null;
}

// ---------------------------------------------------------------------------
// Tile shape preview
// ---------------------------------------------------------------------------

const previewShapeOffsets = computed(() => {
	if (!currentShape.value) return [];
	return rotateTileOffsets(currentShape.value.offsets, rotation.value);
});

const previewShapeBounds = computed(() => {
	const offsets = previewShapeOffsets.value;
	if (offsets.length === 0) return { rows: 0, cols: 0 };
	return {
		rows: Math.max(...offsets.map(([r]) => r)) + 1,
		cols: Math.max(...offsets.map(([, c]) => c)) + 1,
	};
});

const previewShapeSet = computed(() => {
	const set = new Set<string>();
	for (const [r, c] of previewShapeOffsets.value) {
		set.add(`${r},${c}`);
	}
	return set;
});

const myTileTemplate = computed(() => {
	if (!G.value || !playerID.value) return null;
	const player = G.value.players[playerID.value];
	if (!player) return null;
	if (currentEra.value === "I") return player.assignedLTile;
	return player.assignedDominoTiles?.[currentEra.value] ?? null;
});

const previewTileResources = computed((): Map<string, ResourceType[]> => {
	const map = new Map<string, ResourceType[]>();
	const tile = myTileTemplate.value;
	if (!tile) return map;
	const offsets = previewShapeOffsets.value;
	for (let i = 0; i < offsets.length; i++) {
		const res = tile.resources[i];
		if (res && res.length > 0) {
			map.set(`${offsets[i][0]},${offsets[i][1]}`, res);
		}
	}
	return map;
});

// ---------------------------------------------------------------------------
// Water/land edge rendering
// ---------------------------------------------------------------------------

function rotateCellEdgesLocal(edges: CellEdges, rot: TileRotation): CellEdges {
	const [t, r, b, l] = edges;
	switch (rot) {
		case 0:
			return [t, r, b, l];
		case 90:
			return [l, t, r, b];
		case 180:
			return [b, l, t, r];
		case 270:
			return [r, b, l, t];
	}
}

const previewTileEdges = computed((): Map<string, CellEdges> => {
	const map = new Map<string, CellEdges>();
	const tile = myTileTemplate.value;
	if (!tile?.edges) return map;
	const offsets = previewShapeOffsets.value;
	for (let i = 0; i < offsets.length; i++) {
		const edges = tile.edges[i];
		if (edges) {
			map.set(`${offsets[i][0]},${offsets[i][1]}`, rotateCellEdgesLocal(edges, rotation.value));
		}
	}
	return map;
});

function getBoardEdges(row: number, col: number): CellEdges | undefined {
	const gs = G.value as GoldenAgesState | undefined;
	return gs?.boardEdges?.[`${row},${col}`];
}

function getPreviewBoardEdges(row: number, col: number): CellEdges | undefined {
	if (!hoverAnchor.value || !myTileTemplate.value?.edges) return undefined;
	const offsets = previewShapeOffsets.value;
	const [ar, ac] = hoverAnchor.value;
	for (let i = 0; i < offsets.length; i++) {
		if (ar + offsets[i][0] === row && ac + offsets[i][1] === col) {
			return rotateCellEdgesLocal(myTileTemplate.value.edges[i], rotation.value);
		}
	}
	return undefined;
}

function waterEdges(edges: CellEdges | undefined): boolean[] {
	if (!edges) return [false, false, false, false];
	return [edges[0] === "water", edges[1] === "water", edges[2] === "water", edges[3] === "water"];
}

function cellWaterEdges(row: number, col: number): boolean[] {
	const edges = getPreviewBoardEdges(row, col) ?? getBoardEdges(row, col);
	return waterEdges(edges);
}

// Debug: log edge state once on load
const _edgeDebugDone = ref(false);
watch(
	() => G.value,
	(gs) => {
		if (gs && !_edgeDebugDone.value) {
			_edgeDebugDone.value = true;
			const gState = gs as GoldenAgesState;
			console.log("[edge-debug] G keys:", Object.keys(gs));
			console.log("[edge-debug] boardEdges:", gState.boardEdges);
			console.log("[edge-debug] assignedLTile edges:", gState.players?.["0"]?.assignedLTile?.edges);
		}
	},
	{ immediate: true }
);

const boardPreviewResources = computed((): Map<string, ResourceType[]> => {
	const map = new Map<string, ResourceType[]>();
	const tile = myTileTemplate.value;
	if (!tile || !hoverAnchor.value || !currentShape.value) return map;
	const [ar, ac] = hoverAnchor.value;
	const rotated = rotateTileOffsets(currentShape.value.offsets, rotation.value);
	for (let i = 0; i < rotated.length; i++) {
		const res = tile.resources[i];
		if (res && res.length > 0) {
			map.set(`${ar + rotated[i][0]},${ac + rotated[i][1]}`, res);
		}
	}
	return map;
});

// ---------------------------------------------------------------------------
// Board resources
// ---------------------------------------------------------------------------

const RESOURCE_ICONS: Record<ResourceType, { icon: typeof IconDiamond; color: string }> = {
	gem: { icon: IconDiamond, color: "text-cyan-400/60" },
	rock: { icon: IconMountain, color: "text-stone-400/60" },
	game: { icon: IconDeer, color: "text-green-400/60" },
	wheat: { icon: IconWheat, color: "text-amber-400/60" },
};

const ACTION_ICONS: Record<ActionType, typeof IconCompass> = {
	explorer: IconCompass,
	builder: IconHammer,
	artist: IconPalette,
	soldier: IconSword,
	buildWonder: IconBuildingCastle,
	activateBuildingOrWonder: IconBolt,
	developTechnology: IconFlask,
	startGoldenAge: IconSunHigh,
};

function resourcesAt(row: number, col: number): ResourceType[] {
	const key = `${row},${col}`;
	return G.value?.boardResources?.[key] ?? [];
}

// ---------------------------------------------------------------------------
// Board pieces
// ---------------------------------------------------------------------------

function piecesAt(row: number, col: number): BoardPiece[] {
	if (!G.value?.pieces) return [];
	return G.value.pieces.filter((p) => p.row === row && p.col === col && !p.inAgora);
}

function citiesAt(row: number, col: number): BoardCity[] {
	if (!G.value?.cities) return [];
	const result = G.value.cities.filter((c) => c.row === row && c.col === col);
	return result;
}

function pieceColor(piece: BoardPiece): PlayerColor {
	const idx = parseInt(piece.owner, 10);
	return PLAYER_COLORS[idx] ?? "red";
}

const PIECE_COLOR_CLASSES: Record<PlayerColor, string> = {
	red: "text-red-300",
	blue: "text-blue-300",
	green: "text-green-300",
	yellow: "text-yellow-200",
};

const PIECE_FILL_CLASSES: Record<PlayerColor, string> = {
	red: "fill-red-400",
	blue: "fill-blue-400",
	green: "fill-green-400",
	yellow: "fill-yellow-300",
};

const PIECE_STROKE_CLASSES: Record<PlayerColor, string> = {
	red: "text-red-600",
	blue: "text-blue-600",
	green: "text-green-600",
	yellow: "text-yellow-600",
};

const CUBE_BG_CLASSES: Record<PlayerColor, string> = {
	red: "bg-red-400",
	blue: "bg-blue-400",
	green: "bg-green-400",
	yellow: "bg-yellow-300",
};

// ---------------------------------------------------------------------------
// Cell styling helpers
// ---------------------------------------------------------------------------

function cellHasPointer(row: number, col: number): boolean {
	const key = `${row},${col}`;

	if (soldierPhase.value === "selectDest" && soldierReachableSet.value.has(key)) return true;
	if (soldierPhase.value === "selectWorker" && piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted))
		return true;
	if (explorerPhase.value === "selectDest" && explorerReachableSet.value.has(key)) return true;
	if (explorerPhase.value === "selectWorker" && piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted))
		return true;
	if (
		activatingFactory.value !== null &&
		piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && p.exhausted && !p.inAgora)
	)
		return true;
	if (agoraAction.value && piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted && !p.inAgora))
		return true;

	if (
		isMyTurn.value &&
		isActionPhase.value &&
		!myPassedThisEra.value &&
		explorerPhase.value === null &&
		soldierPhase.value === null &&
		agoraAction.value === null &&
		activatingFactory.value === null
	) {
		if (piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted)) return true;
	}

	if (highlightedCells.value.has(key)) return true;

	return false;
}

function cellClasses(row: number, col: number): string {
	const key = `${row},${col}`;

	// Soldier destination highlight
	if (soldierPhase.value === "selectDest" && soldierReachableSet.value.has(key)) {
		const hasEnemy =
			piecesAt(row, col).some((p) => p.type === "worker" && p.owner !== playerID.value && !p.inAgora) ||
			(G.value?.cities ?? []).some((ct) => ct.owner !== playerID.value && ct.row === row && ct.col === col);
		if (hasEnemy) return "bg-red-500/25 border-2 border-red-400/60 hover:bg-red-500/40 hover:border-red-300 transition-colors";
		return "bg-cyan-500/25 border-2 border-cyan-400/60";
	}

	// Soldier worker selection highlight
	if (soldierPhase.value === "selectWorker") {
		const hasWorker = piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted);
		if (hasWorker) return "bg-red-500/20 border-2 border-red-400/50 hover:bg-red-500/40 hover:border-red-300 transition-colors";
	}

	// Explorer destination highlight takes priority on any cell
	if (explorerPhase.value === "selectDest" && explorerReachableSet.value.has(key)) {
		return "bg-cyan-500/25 border-2 border-cyan-400/60";
	}

	// Explorer worker selection highlight
	if (explorerPhase.value === "selectWorker") {
		const hasWorker = piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted);
		if (hasWorker) return "bg-cyan-500/20 border-2 border-cyan-400/50 hover:bg-cyan-500/40 hover:border-cyan-300 transition-colors";
	}

	// Factory: highlight exhausted workers on the map
	if (activatingFactory.value !== null) {
		const hasExhausted = piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && p.exhausted && !p.inAgora);
		if (hasExhausted) return "bg-green-500/20 border-2 border-green-400/50 hover:bg-green-500/40 hover:border-green-300 transition-colors";
	}

	// Agora worker selection highlight
	if (agoraAction.value) {
		const hasWorker = piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted && !p.inAgora);
		if (hasWorker) return "bg-amber-500/20 border-2 border-amber-400/50 hover:bg-amber-500/40 hover:border-amber-300 transition-colors";
	}

	// Determine base tile styling
	let base = "";
	if (isStartingTile(row, col)) {
		base = `bg-amber-900/60 border border-amber-700/40 ${startingTileBorders(row, col)}`;
	} else if (isPlayerTile(row, col)) {
		const color = tileOwnerColor(row, col);
		const bg = color ? PLAYER_TILE_BG[color] : "bg-slate-600";
		const border = color ? PLAYER_TILE_BORDER[color] : "border-slate-500";
		base = `${bg} border ${border} ${playerTileBorders(row, col)}`;
	}

	// Idle actions phase: hover effect on cells with standing workers
	if (
		isMyTurn.value &&
		isActionPhase.value &&
		!myPassedThisEra.value &&
		explorerPhase.value === null &&
		soldierPhase.value === null &&
		agoraAction.value === null &&
		activatingFactory.value === null
	) {
		const hasWorker = piecesAt(row, col).some((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted);
		if (hasWorker) return `${base || "border border-slate-700/20"} hover:brightness-125 transition-all`;
	}

	if (base) return base;

	if (previewCells.value.has(key)) {
		return "bg-green-500/40 border border-green-400/60";
	}

	if (highlightedCells.value.has(key)) {
		return "bg-green-900/40 border border-green-700/50";
	}

	return "border border-slate-700/20";
}

const PLAYER_TILE_BG: Record<PlayerColor, string> = {
	red: "bg-red-800/60",
	blue: "bg-blue-800/60",
	green: "bg-green-800/60",
	yellow: "bg-yellow-700/50",
};

const PLAYER_TILE_BORDER: Record<PlayerColor, string> = {
	red: "border-red-600/50",
	blue: "border-blue-600/50",
	green: "border-green-600/50",
	yellow: "border-yellow-500/50",
};

// ---------------------------------------------------------------------------
// Score track
// ---------------------------------------------------------------------------

const TRACK_CELLS = 100;

// Clockwise from top-left: 0 (TL) → 30 (TR) → 50 (BR) → 80 (BL) → back to 0
const topEdgeCells = Array.from({ length: 31 }, (_, i) => i); // 0..30
const rightEdgeCells = Array.from({ length: 20 }, (_, i) => 31 + i); // 31..50
const bottomEdgeCells = Array.from({ length: 30 }, (_, i) => 80 - i); // 80,79,...,51
const leftEdgeCells = Array.from({ length: 19 }, (_, i) => 99 - i); // 99,98,...,81

function showTrackNumber(pos: number): boolean {
	return pos % 5 === 0;
}

const playersAtTrackPosition = computed(() => {
	const map = new Map<number, PlayerColor[]>();
	if (!G.value?.players) return map;
	for (const p of Object.values(G.value.players)) {
		const pos = (p.score ?? 0) % TRACK_CELLS;
		if (!map.has(pos)) map.set(pos, []);
		map.get(pos)!.push(p.color);
	}
	return map;
});

const gameOverDismissed = ref(false);
const gameIsOver = computed(() => G.value?.endGameScored === true);

const finalRankings = computed(() => {
	if (!gameIsOver.value || !G.value) return [];
	return getPlayerRankings(G.value);
});

// End game: reveal scores one-by-one in fixed order (by playerId) so winner is a surprise
const playersInRevealOrder = computed(() => {
	if (!G.value?.players) return [];
	const order = Object.keys(G.value.players).sort();
	return order.map((pid) => {
		const cityCount = G.value!.cities.filter((c) => c.owner === pid).length;
		return { playerId: pid, score: G.value!.players[pid].score, cities: cityCount };
	});
});
const revealedScoresCount = ref(0);
let revealInterval: ReturnType<typeof setInterval> | null = null;

watch(
	() => gameIsOver.value && !gameOverDismissed.value,
	(isShowing) => {
		if (!isShowing) {
			revealedScoresCount.value = 0;
			if (revealInterval) {
				clearInterval(revealInterval);
				revealInterval = null;
			}
			return;
		}
		revealedScoresCount.value = 0;
		const total = playersInRevealOrder.value.length;
		if (total === 0) return;
		if (revealInterval) clearInterval(revealInterval);
		revealInterval = setInterval(() => {
			revealedScoresCount.value += 1;
			if (revealedScoresCount.value >= total) {
				if (revealInterval) clearInterval(revealInterval);
				revealInterval = null;
			}
		}, 1400);
	},
	{ immediate: true }
);
onUnmounted(() => {
	if (revealInterval) clearInterval(revealInterval);
});

const allScoresRevealed = computed(
	() => playersInRevealOrder.value.length > 0 && revealedScoresCount.value >= playersInRevealOrder.value.length
);

// ---------------------------------------------------------------------------
// Card deck display (only Wonder and Building remain)
// ---------------------------------------------------------------------------

const BACK_COLOR_CLASSES: Record<BackColor, string> = {
	green: "bg-green-700",
	purple: "bg-purple-700",
	orange: "bg-orange-600",
	blue: "bg-blue-700",
	gray: "bg-gray-600",
};

const BACK_COLOR_BORDER: Record<BackColor, string> = {
	green: "border-green-500",
	purple: "border-purple-500",
	orange: "border-orange-400",
	blue: "border-blue-500",
	gray: "border-gray-400",
};

// ---------------------------------------------------------------------------
// History's Judgement cards (face-up)
// ---------------------------------------------------------------------------

const historyCards = computed(() => G.value?.historyJudgementCards ?? []);

// ---------------------------------------------------------------------------
// Player data
// ---------------------------------------------------------------------------

const myPlayer = computed(() => {
	if (!G.value?.players || !playerID.value) return null;
	return G.value.players[playerID.value] ?? null;
});

const PLAYER_COLOR_CLASSES: Record<string, string> = {
	red: "bg-red-600",
	blue: "bg-blue-600",
	green: "bg-green-600",
	yellow: "bg-yellow-500",
};

const PLAYER_COLOR_TEXT: Record<string, string> = {
	red: "text-red-400",
	blue: "text-blue-400",
	green: "text-green-400",
	yellow: "text-yellow-400",
};

const PLAYER_COLOR_BORDER: Record<string, string> = {
	red: "border-red-600",
	blue: "border-blue-600",
	green: "border-green-600",
	yellow: "border-yellow-500",
};

const PLAYER_COLOR_BG_LIGHT: Record<string, string> = {
	red: "bg-red-900/50 border-red-600/60",
	blue: "bg-blue-900/50 border-blue-600/60",
	green: "bg-green-900/50 border-green-600/60",
	yellow: "bg-yellow-900/50 border-yellow-600/60",
};

// ---------------------------------------------------------------------------
// Player board switching
// ---------------------------------------------------------------------------

const playerIds = computed(() => (G.value?.players ? Object.keys(G.value.players) : []));

const viewedPlayerIndex = ref(0);

const viewedPlayerId = computed(() => playerIds.value[viewedPlayerIndex.value] ?? "0");

const viewedPlayer = computed(() => {
	if (!G.value?.players) return null;
	return G.value.players[viewedPlayerId.value] ?? null;
});

const viewedResourceCounts = computed((): Record<ResourceType, number> => {
	const counts: Record<ResourceType, number> = { gem: 0, rock: 0, game: 0, wheat: 0 };
	if (!G.value) return counts;
	for (const [key, owner] of Object.entries(G.value.controlledResources)) {
		if (owner !== viewedPlayerId.value) continue;
		const resources = G.value.boardResources[key];
		if (!resources) continue;
		for (const r of resources) {
			counts[r]++;
		}
	}
	return counts;
});

const isViewingSelf = computed(() => viewedPlayerId.value === playerID.value);

const viewedCivCard = computed(() => {
	if (!G.value?.activeCivCard) return null;
	return G.value.activeCivCard[viewedPlayerId.value] ?? null;
});

const viewedWorkerStatus = computed(() => {
	if (!G.value?.pieces) return { available: 0, exhausted: 0, total: 0 };
	const workers = G.value.pieces.filter((p) => p.type === "worker" && p.owner === viewedPlayerId.value);
	const exhausted = workers.filter((w) => w.exhausted || w.inAgora).length;
	return { available: workers.length - exhausted, exhausted, total: workers.length };
});

const viewedBuildingSlots = computed(() => {
	const p = viewedPlayer.value;
	if (!p) return [false, false, false];
	return getUnlockedBuildingSlots(p);
});

const isSelectingWorker = computed(
	() =>
		explorerPhase.value === "selectWorker" ||
		soldierPhase.value === "selectWorker" ||
		agoraAction.value !== null ||
		activatingFactory.value !== null
);

const hasAvailableWorkers = computed(() => myMapWorkers.value.length > 0);

const canResearchAnyTech = computed(() => {
	const p = myPlayer.value;
	if (!p) return false;
	const jd = japanDiscount.value;
	for (let row = 0; row < TECH_TREE.length; row++) {
		for (let col = 1; col < TECH_TREE[row].length; col++) {
			if (p.researchedTechs[row][col]) continue;
			if (!p.researchedTechs[row][col - 1]) continue;
			if (p.gold >= Math.max(0, TECH_COSTS[col] - jd)) return true;
		}
	}
	return false;
});

const hasActivatableBuilding = computed(() => {
	const p = myPlayer.value;
	if (!p) return false;
	const hasBuilding = p.builtBuildings.some((card, i) => card && !p.activatedBuildings[i] && !PASSIVE_BUILDINGS.has(card.buildingType ?? ""));
	const hasWonder = p.builtWonders.some((card, i) => {
		if (p.activatedWonders[i]) return false;
		const def = WONDER_DEFS[card.era ?? "I"]?.find((d) => d.type === card.wonderType);
		return !!def?.activateDescription;
	});
	return hasBuilding || hasWonder;
});

const canBuilderWorkerless = computed(() => {
	if (!G.value || !playerID.value) return false;
	const civ = G.value.activeCivCard[playerID.value];
	if (civ?.civType === "rome" || civ?.civType === "arabia") return true;
	const p = myPlayer.value;
	if (p && p.researchedTechs[1][4]) return true;
	return false;
});

function isActionAvailable(actionType: ActionType): boolean {
	if (actionType === "explorer" || actionType === "artist" || actionType === "soldier") {
		return hasAvailableWorkers.value;
	}
	if (actionType === "builder") {
		if (!hasAvailableWorkers.value && !canBuilderWorkerless.value) return false;
		if (!myPlayer.value) return false;
		const slots = getUnlockedBuildingSlots(myPlayer.value);
		return slots.some((unlocked, i) => unlocked && myPlayer.value!.builtBuildings[i] === null) && availableBuildings.value.length > 0;
	}
	if (actionType === "buildWonder") {
		if (!myPlayer.value || availableWonders.value.length === 0) return false;
		const p = myPlayer.value;
		const isGreece = G.value?.activeCivCard[playerID.value!]?.civType === "greece";
		if (isGreece && !p.usedGreeceWonder) return true;
		const activeCiv = G.value?.activeCivCard[playerID.value!]?.civType;
		return availableWonders.value.some((w) => {
			let cost = w.wonderCost ?? 0;
			if (activeCiv && activeCiv === w.wonderDiscountCiv) cost = w.wonderDiscountCost ?? cost;
			return p.gold >= cost;
		});
	}
	if (actionType === "developTechnology") return canResearchAnyTech.value;
	if (actionType === "activateBuildingOrWonder") return hasActivatableBuilding.value;
	if (actionType === "startGoldenAge") return !hasAvailableWorkers.value;
	return true;
}

function canDoAction(actionType: ActionType): boolean {
	return (
		isViewingSelf.value &&
		isActionPhase.value &&
		isMyTurn.value &&
		!myPassedThisEra.value &&
		!selectingTech.value &&
		!isExplorerActive.value &&
		!isSoldierActive.value &&
		!isAgoraActive.value &&
		!isActivating.value &&
		!selectingWonder.value &&
		isActionAvailable(actionType)
	);
}

const availableActionTypes = computed(() =>
	ACTION_TYPES.filter((a) => canDoAction(a.type)).map((a) => a.type)
);
const isGoldenAgeOnlyOption = computed(
	() =>
		availableActionTypes.value.length === 1 &&
		availableActionTypes.value[0] === "startGoldenAge"
);
const goldenAgeOnlyPromptDismissed = ref(false);
watch(currentPlayerId, () => {
	goldenAgeOnlyPromptDismissed.value = false;
});
function dismissGoldenAgeOnlyPrompt() {
	goldenAgeOnlyPromptDismissed.value = true;
	confirmGoldenAge.value = true;
}

function isWorkerSelectable(piece: BoardPiece): boolean {
	if (piece.type !== "worker" || piece.owner !== playerID.value) return false;
	if (explorerPhase.value === "selectWorker") return !piece.exhausted;
	if (soldierPhase.value === "selectWorker") return !piece.exhausted;
	if (agoraAction.value) return !piece.exhausted && !piece.inAgora;
	if (activatingFactory.value !== null) return !!piece.exhausted && !piece.inAgora;
	return false;
}

function cyclePlayer(direction: 1 | -1) {
	const len = playerIds.value.length;
	if (len === 0) return;
	viewedPlayerIndex.value = (viewedPlayerIndex.value + direction + len) % len;
}

watch(
	playerID,
	(id) => {
		if (!id) return;
		const idx = playerIds.value.indexOf(id);
		if (idx !== -1) viewedPlayerIndex.value = idx;
	},
	{ immediate: true }
);

// ---------------------------------------------------------------------------
// Action phase
// ---------------------------------------------------------------------------

const currentPlayerId = computed(() => {
	return (state.value as unknown as { ctx?: { currentPlayer?: string } })?.ctx?.currentPlayer ?? null;
});

const currentPlayerColor = computed(() => {
	if (!G.value?.players || !currentPlayerId.value) return null;
	return G.value.players[currentPlayerId.value]?.color ?? null;
});

const isViewedPlayersTurn = computed(() => {
	return currentPlayerId.value === viewedPlayerId.value;
});

const myPassedThisEra = computed(() => myPlayer.value?.passedThisEra ?? false);

const PHASE_LABELS: Record<GamePhase, string> = {
	eraStart: "Era Start",
	tilePlacement: "Tile Placement",
	actions: "Actions",
};

const isFirstGoldenAge = computed(() => {
	if (!G.value?.players) return false;
	return !Object.values(G.value.players).some((p) => p.passedThisEra);
});

const pickingHistoryCard = ref(false);
const confirmGoldenAge = ref(false);

function onAction(actionType: ActionType) {
	if (actionType === "startGoldenAge") {
		confirmGoldenAge.value = true;
		return;
	}
	if (actionType === "developTechnology") {
		selectingTech.value = true;
		scrollToTechGrid();
		return;
	}
	if (actionType === "explorer") {
		onStartExplorer();
		return;
	}
	if (actionType === "soldier") {
		onStartSoldier();
		return;
	}
	if (actionType === "builder") {
		if (!myPlayer.value) return;
		const slots = getUnlockedBuildingSlots(myPlayer.value);
		const hasEmptySlot = slots.some((unlocked, i) => unlocked && myPlayer.value!.builtBuildings[i] === null);
		if (!hasEmptySlot || availableBuildings.value.length === 0) return;
		if (canBuilderWorkerless.value) {
			agoraAction.value = "builder";
			agoraWorkerId.value = "__workerless__";
			return;
		}
		onStartAgoraAction("builder");
		return;
	}
	if (actionType === "artist") {
		onStartAgoraAction("artist");
		return;
	}
	if (actionType === "buildWonder") {
		selectingWonder.value = true;
		return;
	}
	if (actionType === "activateBuildingOrWonder") {
		onStartActivate();
		return;
	}
	move("performAction", actionType);
}

function onConfirmGoldenAge() {
	confirmGoldenAge.value = false;
	if (isFirstGoldenAge.value && historyCards.value.length > 0) {
		pickingHistoryCard.value = true;
		return;
	}
	move("performAction", "startGoldenAge");
}

function onCancelGoldenAge() {
	confirmGoldenAge.value = false;
}

function onPickHistoryCard(cardId: string) {
	pickingHistoryCard.value = false;
	move("performAction", "startGoldenAge", cardId);
}

function onCancelHistoryPick() {
	pickingHistoryCard.value = false;
}

const selectingTech = ref(false);
const techGridEl = ref<HTMLElement | null>(null);

function scrollToTechGrid() {
	nextTick(() => {
		techGridEl.value?.scrollIntoView({ behavior: "smooth", block: "center" });
	});
}

const PLAYER_RESEARCHED_STYLES: Record<string, { bg: string; border: string }> = {
	red: { bg: "#1f1d2b", border: "#9b4d4d" },
	blue: { bg: "#1b1f2e", border: "#4d6a9b" },
	green: { bg: "#1b2420", border: "#4d8b6a" },
	yellow: { bg: "#22211b", border: "#9b8a4d" },
};

const researchedStyle = computed(() => {
	const color = viewedPlayer.value?.color ?? "red";
	return PLAYER_RESEARCHED_STYLES[color] ?? PLAYER_RESEARCHED_STYLES.red;
});

function techState(row: number, col: number): "researched" | "available" | "locked" {
	const techs = viewedPlayer.value?.researchedTechs;
	if (!techs) return "locked";
	if (techs[row]?.[col]) return "researched";
	if (col > 0 && techs[row]?.[col - 1]) return "available";
	return "locked";
}

const isTechSelectionActive = computed(() => selectingTech.value || activatingTechSlot.value !== null);

const japanDiscount = computed(() => {
	if (!G.value || !playerID.value) return 0;
	return G.value.activeCivCard[playerID.value]?.civType === "japan" ? 2 : 0;
});

function techAffordable(row: number, col: number): boolean {
	if (!myPlayer.value) return false;
	if (greatLibraryTechPending.value || oxfordTechPending.value) return true;
	const buildingDiscount = activatingTechSlot.value !== null ? activatingTechDiscount.value : 0;
	const discount = Math.max(buildingDiscount, japanDiscount.value);
	const cost = Math.max(0, TECH_COSTS[col] - discount);
	return myPlayer.value.gold >= cost;
}

const japanTechQueue = ref<[number, number][]>([]);

const japanQueuedGold = computed(() => {
	let total = 0;
	for (const [, col] of japanTechQueue.value) {
		total += Math.max(0, TECH_COSTS[col] - japanDiscount.value);
	}
	return total;
});

function japanTechState(row: number, col: number): "researched" | "available" | "locked" {
	const techs = myPlayer.value?.researchedTechs;
	if (!techs) return "locked";
	if (techs[row]?.[col]) return japanTechQueue.value.some(([r, c]) => r === row && c === col) ? "researched" : "researched";
	if (japanTechQueue.value.some(([r, c]) => r === row && c === col)) return "researched";
	const prevResearched = techs[row]?.[col - 1] || japanTechQueue.value.some(([r, c]) => r === row && c === col - 1);
	if (col > 0 && prevResearched) return "available";
	return "locked";
}

function japanTechAffordable(row: number, col: number): boolean {
	if (!myPlayer.value) return false;
	const cost = Math.max(0, TECH_COSTS[col] - japanDiscount.value);
	return myPlayer.value.gold - japanQueuedGold.value >= cost;
}

function oxfordTechState(row: number, col: number): "researched" | "available" | "locked" {
	const techs = myPlayer.value?.researchedTechs;
	if (!techs) return "locked";
	if (techs[row]?.[col]) return "researched";
	if (oxfordTechQueue.value.some(([r, c]) => r === row && c === col)) return "researched";
	const prevResearched = techs[row]?.[col - 1] || oxfordTechQueue.value.some(([r, c]) => r === row && c === col - 1);
	if (col > 0 && prevResearched) return "available";
	return "locked";
}

function effectiveTechState(row: number, col: number): "researched" | "available" | "locked" {
	if (oxfordTechPending.value) return oxfordTechState(row, col);
	return japanTechQueue.value.length > 0 ? japanTechState(row, col) : techState(row, col);
}

function effectiveTechAffordable(row: number, col: number): boolean {
	if (oxfordTechPending.value) return true;
	return japanTechQueue.value.length > 0 ? japanTechAffordable(row, col) : techAffordable(row, col);
}

function onSelectTech(row: number, col: number) {
	if (greatLibraryTechPending.value) {
		onGreatLibraryTech(row, col);
		return;
	}
	if (oxfordTechPending.value) {
		onOxfordTech(row, col);
		return;
	}
	if (activatingTechSlot.value !== null) {
		onLibraryTech(row, col);
		return;
	}
	if (japanDiscount.value > 0) {
		japanTechQueue.value.push([row, col]);
		return;
	}
	selectingTech.value = false;
	move("performAction", "developTechnology", row, col);
}

function onConfirmJapanTechs() {
	if (japanTechQueue.value.length === 0) return;
	if (japanTechQueue.value.length === 1) {
		const [row, col] = japanTechQueue.value[0];
		move("performAction", "developTechnology", row, col);
	} else {
		const flat = japanTechQueue.value.flat();
		move("performAction", "developTechnology", flat);
	}
	japanTechQueue.value = [];
	selectingTech.value = false;
}

function onCancelTechSelect() {
	if (greatLibraryTechPending.value || oxfordTechPending.value) {
		cancelWonderSelect();
		return;
	}
	if (activatingTechSlot.value !== null) {
		resetActivate();
		return;
	}
	japanTechQueue.value = [];
	selectingTech.value = false;
}

// ---------------------------------------------------------------------------
// Explorer action flow
// ---------------------------------------------------------------------------

const explorerPhase = ref<"selectWorker" | "selectDest" | "confirmCity" | null>(null);
const selectedWorkerId = ref<string | null>(null);
const explorerDest = ref<[number, number] | null>(null);

const myNonExhaustedWorkers = computed(() => {
	if (!G.value || !playerID.value) return [];
	return G.value.pieces.filter((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted);
});

const selectedWorker = computed(() => {
	if (!selectedWorkerId.value || !G.value) return null;
	return G.value.pieces.find((p) => p.id === selectedWorkerId.value) ?? null;
});

const explorerReachableCells = computed((): [number, number][] => {
	const w = selectedWorker.value;
	if (!w || !G.value || !playerID.value) return [];
	const player = G.value.players[playerID.value];
	if (!player) return [];
	const range = getMovementRange(player);
	return getReachableCells(6, 10, w.row, w.col, range);
});

const explorerReachableSet = computed(() => {
	const s = new Set<string>();
	for (const [r, c] of explorerReachableCells.value) {
		s.add(`${r},${c}`);
	}
	return s;
});

const canFoundCityAtDest = computed(() => {
	if (!explorerDest.value || !G.value || !playerID.value) return false;
	const [r, c] = explorerDest.value;
	const tileInfo = getTileAt(G.value.tiles, r, c);
	if (!tileInfo) return false;
	const hasCapitalOrCity =
		G.value.pieces.some((p) => p.type === "capital" && p.row === r && p.col === c) || G.value.cities.some((ct) => ct.row === r && ct.col === c);
	if (hasCapitalOrCity) return false;
	const player = G.value.players[playerID.value];
	if (!player) return false;
	const hasConstruction = player.researchedTechs?.[2]?.[2];
	const cubeCost = hasConstruction ? 2 : 1;
	if (player.cubes < cubeCost) return false;
	return true;
});

function onStartExplorer() {
	explorerPhase.value = "selectWorker";
	selectedWorkerId.value = null;
	explorerDest.value = null;
}

function onSelectWorker(piece: BoardPiece) {
	selectedWorkerId.value = piece.id;
	explorerPhase.value = "selectDest";
}

function onSelectExplorerDest(row: number, col: number) {
	explorerDest.value = [row, col];
	if (canFoundCityAtDest.value) {
		explorerPhase.value = "confirmCity";
	} else {
		move("performAction", "explorer", selectedWorkerId.value!, row, col, false);
		resetExplorer();
	}
}

function onConfirmCity(found: boolean) {
	if (!explorerDest.value) return;
	const [r, c] = explorerDest.value;
	move("performAction", "explorer", selectedWorkerId.value!, r, c, found);
	resetExplorer();
}

function resetExplorer() {
	explorerPhase.value = null;
	selectedWorkerId.value = null;
	explorerDest.value = null;
}

const isExplorerActive = computed(() => explorerPhase.value !== null);

// ---------------------------------------------------------------------------
// Soldier action flow
// ---------------------------------------------------------------------------

const soldierPhase = ref<"selectWorker" | "selectDest" | "confirmAttack" | "confirmCity" | null>(null);
const soldierWorkerId = ref<string | null>(null);
const soldierDest = ref<[number, number] | null>(null);

const soldierWorker = computed(() => {
	if (!soldierWorkerId.value || !G.value) return null;
	return G.value.pieces.find((p) => p.id === soldierWorkerId.value) ?? null;
});

const soldierReachableCells = computed((): [number, number][] => {
	const w = soldierWorker.value;
	if (!w || !G.value || !playerID.value) return [];
	const player = G.value.players[playerID.value];
	if (!player) return [];
	const range = getMovementRange(player);
	return getReachableCells(6, 10, w.row, w.col, range);
});

const soldierReachableSet = computed(() => {
	const s = new Set<string>();
	for (const [r, c] of soldierReachableCells.value) {
		s.add(`${r},${c}`);
	}
	return s;
});

const soldierEnemiesAtDest = computed(() => {
	if (!soldierDest.value || !G.value || !playerID.value)
		return { workers: [] as BoardPiece[], cities: [] as BoardCity[], defenderIds: [] as string[] };
	const [r, c] = soldierDest.value;
	const workers = G.value.pieces.filter((p) => p.type === "worker" && p.owner !== playerID.value && p.row === r && p.col === c && !p.inAgora);
	const cities = G.value.cities.filter((ct) => ct.owner !== playerID.value && ct.row === r && ct.col === c);
	const ids = new Set<string>();
	for (const w of workers) ids.add(w.owner);
	for (const ct of cities) ids.add(ct.owner);
	return { workers, cities, defenderIds: [...ids] };
});

const soldierAttackCost = computed(() => {
	if (!G.value || !playerID.value) return 0;
	let total = 0;
	for (const did of soldierEnemiesAtDest.value.defenderIds) {
		total += getAttackCost(G.value, playerID.value, did);
	}
	return total;
});

const canFoundCityAtSoldierDest = computed(() => {
	if (!soldierDest.value || !G.value || !playerID.value) return false;
	const [r, c] = soldierDest.value;
	const tileInfo = getTileAt(G.value.tiles, r, c);
	if (!tileInfo) return false;
	const hasEnemies = soldierEnemiesAtDest.value.workers.length > 0 || soldierEnemiesAtDest.value.cities.length > 0;
	const hasCapitalOrCity =
		G.value.pieces.some((p) => p.type === "capital" && p.row === r && p.col === c) ||
		G.value.cities.some((ct) => ct.row === r && ct.col === c && (hasEnemies ? ct.owner === playerID.value : true));
	if (hasCapitalOrCity && !hasEnemies) return false;
	if (!hasEnemies) {
		const player = G.value.players[playerID.value];
		if (!player) return false;
		const hasConstruction = player.researchedTechs?.[2]?.[2];
		const cubeCost = hasConstruction ? 2 : 1;
		if (player.cubes < cubeCost) return false;
	} else {
		const player = G.value.players[playerID.value];
		if (!player) return false;
		const hasConstruction = player.researchedTechs?.[2]?.[2];
		const cubeCost = hasConstruction ? 2 : 1;
		if (player.cubes < cubeCost) return false;
		const friendlyCapOrCity =
			G.value.pieces.some((p) => p.type === "capital" && p.owner === playerID.value && p.row === r && p.col === c) ||
			G.value.cities.some((ct) => ct.owner === playerID.value && ct.row === r && ct.col === c);
		if (friendlyCapOrCity) return false;
	}
	return true;
});

function onStartSoldier() {
	soldierPhase.value = "selectWorker";
	soldierWorkerId.value = null;
	soldierDest.value = null;
}

function onSelectSoldierWorker(piece: BoardPiece) {
	soldierWorkerId.value = piece.id;
	soldierPhase.value = "selectDest";
}

function onSelectSoldierDest(row: number, col: number) {
	soldierDest.value = [row, col];
	const hasEnemies = soldierEnemiesAtDest.value.defenderIds.length > 0;
	if (hasEnemies) {
		soldierPhase.value = "confirmAttack";
	} else if (canFoundCityAtSoldierDest.value) {
		soldierPhase.value = "confirmCity";
	} else {
		move("performAction", "soldier", soldierWorkerId.value!, row, col, false);
		resetSoldier();
	}
}

function onConfirmAttack(proceed: boolean) {
	if (!proceed || !soldierDest.value) {
		resetSoldier();
		return;
	}
	const [r, c] = soldierDest.value;
	if (canFoundCityAtSoldierDest.value) {
		soldierPhase.value = "confirmCity";
	} else {
		move("performAction", "soldier", soldierWorkerId.value!, r, c, false);
		resetSoldier();
	}
}

function onSoldierConfirmCity(found: boolean) {
	if (!soldierDest.value) return;
	const [r, c] = soldierDest.value;
	move("performAction", "soldier", soldierWorkerId.value!, r, c, found);
	resetSoldier();
}

function resetSoldier() {
	soldierPhase.value = null;
	soldierWorkerId.value = null;
	soldierDest.value = null;
}

const isSoldierActive = computed(() => soldierPhase.value !== null);

// ---------------------------------------------------------------------------
// Agora actions (Builder / Artist)
// ---------------------------------------------------------------------------

const agoraAction = ref<"builder" | "artist" | null>(null);
const agoraWorkerId = ref<string | null>(null);
const pendingBuildingCardId = ref<string | null>(null);

const agoraWorkers = computed(() => {
	if (!G.value?.pieces) return [];
	return G.value.pieces.filter((p) => p.inAgora);
});

const myMapWorkers = computed(() => {
	if (!G.value || !playerID.value) return [];
	return G.value.pieces.filter((p) => p.type === "worker" && p.owner === playerID.value && !p.exhausted && !p.inAgora);
});

function onStartAgoraAction(action: "builder" | "artist") {
	agoraAction.value = action;
	agoraWorkerId.value = null;
}

function wonderActivatable(wonder: { era?: string; wonderType?: string }, wIdx: number): boolean {
	const def = WONDER_DEFS[(wonder.era ?? "I") as keyof typeof WONDER_DEFS]?.find((d) => d.type === wonder.wonderType);
	return !!def?.activateDescription && !viewedPlayer.value?.activatedWonders?.[wIdx];
}

function wonderHasActivate(wonder: { era?: string; wonderType?: string }): boolean {
	const def = WONDER_DEFS[(wonder.era ?? "I") as keyof typeof WONDER_DEFS]?.find((d) => d.type === wonder.wonderType);
	return !!def?.activateDescription;
}

function onSelectAgoraWorker(piece: BoardPiece) {
	if (agoraAction.value === "artist") {
		move("performAction", "artist", piece.id);
		resetAgora();
	} else if (agoraAction.value === "builder") {
		if (pendingBuildingCardId.value) {
			move("performAction", "builder", piece.id, pendingBuildingCardId.value);
			resetAgora();
		} else {
			agoraWorkerId.value = piece.id;
		}
	}
}

function onSelectBuildingCard(cardId: string) {
	if (agoraAction.value !== "builder") {
		if (!canDoAction("builder")) return;
		if (!myPlayer.value) return;
		const slots = getUnlockedBuildingSlots(myPlayer.value);
		const hasEmptySlot = slots.some((unlocked, i) => unlocked && myPlayer.value!.builtBuildings[i] === null);
		if (!hasEmptySlot || availableBuildings.value.length === 0) return;
		if (canBuilderWorkerless.value) {
			move("performAction", "builder", "__workerless__", cardId);
			return;
		}
		agoraAction.value = "builder";
		pendingBuildingCardId.value = cardId;
		return;
	}
	if (!agoraWorkerId.value) return;
	move("performAction", "builder", agoraWorkerId.value, cardId);
	resetAgora();
}

function resetAgora() {
	agoraAction.value = null;
	agoraWorkerId.value = null;
	pendingBuildingCardId.value = null;
}

const isAgoraActive = computed(() => agoraAction.value !== null);

function onCollectIncome() {
	move("collectGoldenAgeIncome");
}

// ---------------------------------------------------------------------------
// Activate Building / Wonder
// ---------------------------------------------------------------------------

const TECH_DISCOUNT_BUILDINGS: Record<string, number> = {
	library: 2,
	university: 3,
	observatory: 5,
	laboratory: 99,
};

const activatingBuilding = ref(false);
const activatingTechSlot = ref<number | null>(null);
const activatingTechDiscount = ref(0);
const activatingFactory = ref<number | null>(null);

function onStartActivate() {
	if (!myPlayer.value) return;
	if (!hasActivatableBuilding.value) return;
	activatingBuilding.value = true;
}

const notreDamePending = ref<number | null>(null);

function onActivateWonder(wonderIdx: number) {
	if (!activatingBuilding.value || !myPlayer.value) return;
	const p = myPlayer.value;
	if (wonderIdx < 0 || wonderIdx >= p.builtWonders.length) return;
	if (p.activatedWonders[wonderIdx]) return;
	const card = p.builtWonders[wonderIdx];
	const def = WONDER_DEFS[card.era ?? "I"]?.find((d) => d.type === card.wonderType);
	if (!def?.activateDescription) return;

	if (card.wonderType === "notreDame") {
		notreDamePending.value = wonderIdx;
		return;
	}

	move("performAction", "activateBuildingOrWonder", 100 + wonderIdx);
	resetActivate();
}

function onNotreDameChoice(direction: 0 | 1) {
	if (notreDamePending.value === null) return;
	move("performAction", "activateBuildingOrWonder", 100 + notreDamePending.value, direction);
	notreDamePending.value = null;
	resetActivate();
}

function onActivateSlot(slotIdx: number) {
	if (!activatingBuilding.value || !myPlayer.value) return;
	const card = myPlayer.value.builtBuildings[slotIdx];
	if (!card || myPlayer.value.activatedBuildings[slotIdx]) return;
	if (PASSIVE_BUILDINGS.has(card.buildingType ?? "")) return;

	const discount = TECH_DISCOUNT_BUILDINGS[card.buildingType ?? ""];
	if (discount !== undefined) {
		activatingTechSlot.value = slotIdx;
		activatingTechDiscount.value = discount;
		return;
	}
	if (card.buildingType === "factory") {
		activatingFactory.value = slotIdx;
		return;
	}

	move("performAction", "activateBuildingOrWonder", slotIdx);
	resetActivate();
}

function onLibraryTech(row: number, col: number) {
	if (activatingTechSlot.value === null) return;
	move("performAction", "activateBuildingOrWonder", activatingTechSlot.value, row, col);
	resetActivate();
}

function onSelectFactoryWorker(workerId: string) {
	if (activatingFactory.value === null) return;
	move("performAction", "activateBuildingOrWonder", activatingFactory.value, workerId);
	resetActivate();
}

function resetActivate() {
	activatingBuilding.value = false;
	activatingTechSlot.value = null;
	activatingTechDiscount.value = 0;
	activatingFactory.value = null;
	notreDamePending.value = null;
}

const isActivating = computed(
	() => activatingBuilding.value || activatingTechSlot.value !== null || activatingFactory.value !== null || notreDamePending.value !== null
);

// ---------------------------------------------------------------------------
// Build Wonder
// ---------------------------------------------------------------------------

const selectingWonder = ref(false);
const greatLibraryTechPending = ref<string | null>(null);
const oxfordTechPending = ref<string | null>(null);
const oxfordTechQueue = ref<[number, number][]>([]);
const greeceWonderPending = ref<string | null>(null);
const greeceWonderUseFree = ref(false);

const isGreeceFreeAvailable = computed(() => {
	if (!G.value || !playerID.value) return false;
	const isGreece = G.value.activeCivCard[playerID.value]?.civType === "greece";
	return isGreece && !!myPlayer.value && !myPlayer.value.usedGreeceWonder;
});

function getWonderCost(card: { wonderCost?: number; wonderDiscountCiv?: string; wonderDiscountCost?: number }): number {
	if (!G.value || !playerID.value) return card.wonderCost ?? 0;
	const activeCiv = G.value.activeCivCard[playerID.value]?.civType;
	if (activeCiv && activeCiv === card.wonderDiscountCiv) return card.wonderDiscountCost ?? card.wonderCost ?? 0;
	return card.wonderCost ?? 0;
}

function canAffordWonder(card: { wonderCost?: number; wonderDiscountCiv?: string; wonderDiscountCost?: number }): boolean {
	if (isGreeceFreeAvailable.value) return true;
	return (myPlayer.value?.gold ?? 0) >= getWonderCost(card);
}

function hasWonderDiscount(card: { wonderCost?: number; wonderDiscountCiv?: string; wonderDiscountCost?: number }): boolean {
	return (card.wonderCost ?? 0) !== getWonderCost(card);
}

const CIV_DISPLAY_NAMES: Record<string, string> = {
	babylon: "Babylon",
	phoenicia: "Phoenicia",
	egypt: "Egypt",
	greece: "Greece",
	persia: "Persia",
	rome: "Rome",
	china: "China",
	france: "France",
	byzantine: "Byzantine",
	arabia: "Arabia",
	england: "England",
	russia: "Russia",
	usa: "USA",
};

function onClickWonderCard(cardId: string) {
	if (!selectingWonder.value) {
		if (!canDoAction("buildWonder")) return;
		const card = availableWonders.value.find((c) => c.id === cardId);
		if (!card || !canAffordWonder(card)) return;
		selectingWonder.value = true;
	}
	if (!canAffordWonder(availableWonders.value.find((c) => c.id === cardId)!)) return;
	onSelectWonderToBuild(cardId);
}

function onSelectWonderToBuild(cardId: string) {
	if (!selectingWonder.value) return;
	const card = availableWonders.value.find((c) => c.id === cardId);
	if (!card || !canAffordWonder(card)) return;

	if (isGreeceFreeAvailable.value) {
		greeceWonderPending.value = cardId;
		return;
	}

	proceedBuildWonder(cardId, false);
}

function onGreeceWonderChoice(useFree: boolean) {
	const cardId = greeceWonderPending.value;
	if (!cardId) return;
	greeceWonderPending.value = null;

	if (!useFree) {
		const card = availableWonders.value.find((c) => c.id === cardId);
		if (!card || (myPlayer.value?.gold ?? 0) < getWonderCost(card)) return;
	}

	proceedBuildWonder(cardId, useFree);
}

function onCancelGreeceChoice() {
	greeceWonderPending.value = null;
}

function proceedBuildWonder(cardId: string, useGreeceFree: boolean) {
	const card = availableWonders.value.find((c) => c.id === cardId);
	if (!card) return;

	if (card.wonderType === "greatLibrary") {
		greatLibraryTechPending.value = cardId;
		greeceWonderUseFree.value = useGreeceFree;
		selectingTech.value = true;
		scrollToTechGrid();
		return;
	}

	if (card.wonderType === "oxfordUniversity") {
		oxfordTechPending.value = cardId;
		greeceWonderUseFree.value = useGreeceFree;
		oxfordTechQueue.value = [];
		selectingTech.value = true;
		scrollToTechGrid();
		return;
	}

	move("performAction", "buildWonder", cardId, undefined, undefined, useGreeceFree);
	selectingWonder.value = false;
}

function onGreatLibraryTech(row: number, col: number) {
	if (!greatLibraryTechPending.value) return;
	move("performAction", "buildWonder", greatLibraryTechPending.value, row, col, greeceWonderUseFree.value);
	greatLibraryTechPending.value = null;
	greeceWonderUseFree.value = false;
	selectingTech.value = false;
	selectingWonder.value = false;
}

function onOxfordTech(row: number, col: number) {
	oxfordTechQueue.value.push([row, col]);
	if (oxfordTechQueue.value.length >= 2) {
		onConfirmOxford();
	}
}

function onConfirmOxford() {
	if (!oxfordTechPending.value || oxfordTechQueue.value.length === 0) return;
	const flat = oxfordTechQueue.value.flat();
	move("performAction", "buildWonder", oxfordTechPending.value, flat, undefined, greeceWonderUseFree.value);
	oxfordTechPending.value = null;
	oxfordTechQueue.value = [];
	greeceWonderUseFree.value = false;
	selectingTech.value = false;
	selectingWonder.value = false;
}

function cancelWonderSelect() {
	selectingWonder.value = false;
	greatLibraryTechPending.value = null;
	oxfordTechPending.value = null;
	oxfordTechQueue.value = [];
	greeceWonderPending.value = null;
	greeceWonderUseFree.value = false;
	selectingTech.value = false;
}

const isWonderTechActive = computed(() => greatLibraryTechPending.value !== null || oxfordTechPending.value !== null);
const isWonderSelecting = computed(() => selectingWonder.value);

// ---------------------------------------------------------------------------
// Era start phase
// ---------------------------------------------------------------------------

const availableWonders = computed(() => G.value?.availableWonders ?? []);
const availableBuildings = computed(() => G.value?.availableBuildings ?? []);

const myActiveCivCard = computed(() => {
	if (!G.value?.activeCivCard || !playerID.value) return null;
	return G.value.activeCivCard[playerID.value] ?? null;
});

const myEraCard = computed(() => {
	if (!myPlayer.value) return null;
	return myPlayer.value.hand.find((c) => c.cardType === "civilisation" && c.era === currentEra.value) ?? null;
});

const pendingIndiaCivKeepOld = ref<boolean | null>(null);

function onChooseCivCard(keepOld: boolean) {
	const cardToUse = keepOld ? myActiveCivCard.value : myEraCard.value;
	if (cardToUse?.civType === "india") {
		pendingIndiaCivKeepOld.value = keepOld;
		return;
	}
	move("chooseCivCard", keepOld);
}

function onIndiaSelectTech(row: number) {
	if (pendingIndiaCivKeepOld.value === null) return;
	move("chooseCivCard", pendingIndiaCivKeepOld.value, row);
	pendingIndiaCivKeepOld.value = null;
}

function onCancelIndia() {
	pendingIndiaCivKeepOld.value = null;
}

type PromptType =
	| "capitalMove"
	| "foundCity"
	| "collectIncome"
	| "pickHistory"
	| "confirmGoldenAge"
	| "goldenAgeOnly"
	| "soldierAttack"
	| "soldierCity"
	| "indiaSelect"
	| "greeceWonder";

const activePrompt = computed((): PromptType | null => {
	if (!isViewingSelf.value) return null;
	if (pendingPlacement.value) return "capitalMove";
	if (explorerPhase.value === "confirmCity") return "foundCity";
	if (soldierPhase.value === "confirmAttack") return "soldierAttack";
	if (soldierPhase.value === "confirmCity") return "soldierCity";
	if (pendingIndiaCivKeepOld.value !== null) return "indiaSelect";
	if (greeceWonderPending.value !== null) return "greeceWonder";
	if (isActionPhase.value && isMyTurn.value && confirmGoldenAge.value) return "confirmGoldenAge";
	if (isActionPhase.value && isMyTurn.value && pickingHistoryCard.value) return "pickHistory";
	if (
		isActionPhase.value &&
		isMyTurn.value &&
		!myPassedThisEra.value &&
		isGoldenAgeOnlyOption.value &&
		!goldenAgeOnlyPromptDismissed.value
	)
		return "goldenAgeOnly";
	if (isActionPhase.value && isMyTurn.value && myPassedThisEra.value) return "collectIncome";
	return null;
});

watch(activePrompt, (newVal) => {
	if (newVal) window.scrollTo({ top: 0, behavior: "smooth" });
});
</script>

<template>
	<!-- Pinned prompt banner (fixed below header) -->
	<Teleport to="body">
		<div
			v-if="activePrompt"
			class="fixed left-0 right-0 z-30 bg-slate-800/95 border-b border-amber-600/40 backdrop-blur-sm"
			:style="{ top: props.headerHeight + 'px' }"
		>
			<div class="max-w-5xl mx-auto px-3 md:px-6 py-2 md:py-3 flex flex-wrap items-center justify-center gap-2 md:gap-4">
				<!-- Capital relocation -->
				<template v-if="activePrompt === 'capitalMove'">
					<p class="text-xs md:text-sm text-slate-200 font-medium">Move your capital and workers to the new tile?</p>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs md:text-sm font-medium transition-colors"
						@click="confirmPlacement(true)"
					>
						Yes, move capital
					</button>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs md:text-sm font-medium transition-colors"
						@click="confirmPlacement(false)"
					>
						No, keep it
					</button>
					<button class="text-xs text-slate-500 hover:text-slate-300 transition-colors" @click="cancelPlacement">Cancel</button>
				</template>

				<!-- City founding -->
				<template v-else-if="activePrompt === 'foundCity'">
					<p class="text-xs md:text-sm text-slate-200 font-medium">Found a city here?</p>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs md:text-sm font-medium transition-colors"
						@click="onConfirmCity(true)"
					>
						Yes
					</button>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs md:text-sm font-medium transition-colors"
						@click="onConfirmCity(false)"
					>
						No
					</button>
				</template>

				<!-- Soldier attack confirmation -->
				<template v-else-if="activePrompt === 'soldierAttack'">
					<p class="text-xs md:text-sm text-red-300 font-medium">Attack for {{ soldierAttackCost }} gold?</p>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white text-xs md:text-sm font-medium transition-colors"
						@click="onConfirmAttack(true)"
					>
						Attack
					</button>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs md:text-sm font-medium transition-colors"
						@click="onConfirmAttack(false)"
					>
						Cancel
					</button>
				</template>

				<!-- Soldier city founding after combat -->
				<template v-else-if="activePrompt === 'soldierCity'">
					<p class="text-xs md:text-sm text-slate-200 font-medium">Found a city here?</p>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white text-xs md:text-sm font-medium transition-colors"
						@click="onSoldierConfirmCity(true)"
					>
						Yes
					</button>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs md:text-sm font-medium transition-colors"
						@click="onSoldierConfirmCity(false)"
					>
						No
					</button>
				</template>

				<!-- India tech selection -->
				<template v-else-if="activePrompt === 'indiaSelect'">
					<p class="text-xs md:text-sm text-purple-300 font-medium shrink-0">Choose a level 5 technology:</p>
					<div class="flex flex-wrap md:flex-nowrap gap-2">
						<button
							v-for="(row, rIdx) in TECH_TREE"
							:key="`india-${rIdx}`"
							class="px-3 py-1.5 rounded-lg text-white text-xs font-medium transition-colors"
							:class="
								myPlayer?.researchedTechs[rIdx][4]
									? 'bg-slate-700/40 text-slate-500 cursor-default'
									: 'bg-purple-700 hover:bg-purple-600 cursor-pointer'
							"
							:disabled="myPlayer?.researchedTechs[rIdx][4] ?? false"
							@click="!myPlayer?.researchedTechs[rIdx][4] && onIndiaSelectTech(rIdx)"
						>
							{{ row[4].name }}
						</button>
					</div>
					<button class="text-xs text-slate-500 hover:text-slate-300 transition-colors" @click="onCancelIndia">Cancel</button>
				</template>

				<!-- Greece free wonder choice -->
				<template v-else-if="activePrompt === 'greeceWonder'">
					<p class="text-xs md:text-sm text-purple-300 font-medium shrink-0">
						Build
						<span class="text-purple-100 font-semibold">{{ availableWonders.find((c) => c.id === greeceWonderPending)?.name }}</span> —
						use Greece ability (free, once per game)?
					</p>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 text-white text-xs md:text-sm font-medium transition-colors cursor-pointer"
						@click="onGreeceWonderChoice(true)"
					>
						Build Free
					</button>
					<button
						v-if="(myPlayer?.gold ?? 0) >= getWonderCost(availableWonders.find((c) => c.id === greeceWonderPending)!)"
						class="px-3 md:px-4 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs md:text-sm font-medium transition-colors cursor-pointer"
						@click="onGreeceWonderChoice(false)"
					>
						Pay {{ getWonderCost(availableWonders.find((c) => c.id === greeceWonderPending)!) }}g
					</button>
					<button class="text-xs text-slate-500 hover:text-slate-300 transition-colors cursor-pointer" @click="onCancelGreeceChoice">
						Cancel
					</button>
				</template>

				<!-- Golden Age only option info -->
				<template v-else-if="activePrompt === 'goldenAgeOnly'">
					<p class="text-xs md:text-sm text-slate-200 font-medium">
						Your only available action is to start a Golden Age.
					</p>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs md:text-sm font-medium transition-colors"
						@click="dismissGoldenAgeOnlyPrompt"
					>
						OK
					</button>
				</template>

				<!-- Confirm Golden Age -->
				<template v-else-if="activePrompt === 'confirmGoldenAge'">
					<p class="text-xs md:text-sm text-amber-300 font-medium">
						Start a Golden Age? You will not be able to take actions for the rest of this era.
					</p>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs md:text-sm font-medium transition-colors cursor-pointer"
						@click="onConfirmGoldenAge"
					>
						Yes
					</button>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs md:text-sm font-medium transition-colors cursor-pointer"
						@click="onCancelGoldenAge"
					>
						Cancel
					</button>
				</template>

				<!-- Collect golden age income -->
				<template v-else-if="activePrompt === 'collectIncome'">
					<p class="text-xs md:text-sm text-slate-200 font-medium">You are in a Golden Age.</p>
					<button
						class="px-3 md:px-4 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs md:text-sm font-medium transition-colors"
						@click="onCollectIncome"
					>
						Collect 2 Gold
					</button>
				</template>

				<!-- Pick History's Judgement card -->
				<template v-else-if="activePrompt === 'pickHistory'">
					<p class="text-xs md:text-sm text-amber-300 font-medium shrink-0">Pick a History's Judgement card:</p>
					<div class="flex gap-2 overflow-x-auto">
						<button
							v-for="card in historyCards"
							:key="card.id"
							class="w-[90px] h-[126px] rounded-lg border-2 bg-gray-700 border-gray-500 text-xs font-medium shrink-0 flex flex-col justify-between p-2 hover:border-amber-400 hover:bg-gray-600 transition-colors cursor-pointer"
							@click="onPickHistoryCard(card.id)"
						>
							<div>
								<div class="text-amber-300 font-bold leading-tight text-[10px]">{{ card.name }}</div>
								<div class="text-gray-300 leading-tight text-[8px] mt-1">{{ card.description }}</div>
							</div>
							<div class="text-gray-500 text-[8px]">Judgement</div>
						</button>
					</div>
					<button class="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0" @click="onCancelHistoryPick">
						Cancel
					</button>
				</template>
			</div>
		</div>
	</Teleport>

	<!-- Spacer to push content below the fixed prompt banner -->
	<div v-if="activePrompt" class="h-10 md:h-12" />

	<div v-if="G?.board" class="flex flex-col items-center gap-4 md:gap-6 w-full max-w-5xl mx-auto px-2 md:px-0">
		<!-- Tile placement controls -->
		<div v-if="isTilePlacement && isMyTurn" class="flex items-center gap-4">
			<span class="text-sm text-slate-400">Your tile:</span>

			<div
				class="inline-grid gap-px"
				:style="{
					gridTemplateColumns: `repeat(${previewShapeBounds.cols}, 40px)`,
					gridTemplateRows: `repeat(${previewShapeBounds.rows}, 40px)`,
				}"
			>
				<template v-for="r in previewShapeBounds.rows" :key="r">
					<div
						v-for="c in previewShapeBounds.cols"
						:key="`${r},${c}`"
						class="rounded-sm flex items-center justify-center relative"
						:class="previewShapeSet.has(`${r - 1},${c - 1}`) ? 'bg-green-700/50 border border-green-500/60' : 'bg-transparent'"
					>
						<template v-if="previewTileEdges.has(`${r - 1},${c - 1}`)">
							<div
								v-if="waterEdges(previewTileEdges.get(`${r - 1},${c - 1}`))[0]"
								class="absolute top-0 left-0 right-0 h-[2px] bg-blue-400/70 pointer-events-none z-10"
							/>
							<div
								v-if="waterEdges(previewTileEdges.get(`${r - 1},${c - 1}`))[1]"
								class="absolute top-0 right-0 bottom-0 w-[2px] bg-blue-400/70 pointer-events-none z-10"
							/>
							<div
								v-if="waterEdges(previewTileEdges.get(`${r - 1},${c - 1}`))[2]"
								class="absolute bottom-0 left-0 right-0 h-[2px] bg-blue-400/70 pointer-events-none z-10"
							/>
							<div
								v-if="waterEdges(previewTileEdges.get(`${r - 1},${c - 1}`))[3]"
								class="absolute top-0 left-0 bottom-0 w-[2px] bg-blue-400/70 pointer-events-none z-10"
							/>
						</template>
						<template v-if="previewTileResources.has(`${r - 1},${c - 1}`)">
							<template v-if="previewTileResources.get(`${r - 1},${c - 1}`)!.length === 1">
								<component
									:is="RESOURCE_ICONS[previewTileResources.get(`${r - 1},${c - 1}`)![0]].icon"
									:size="20"
									:class="RESOURCE_ICONS[previewTileResources.get(`${r - 1},${c - 1}`)![0]].color"
								/>
							</template>
							<template v-else>
								<component
									:is="RESOURCE_ICONS[previewTileResources.get(`${r - 1},${c - 1}`)![0]].icon"
									:size="16"
									:class="RESOURCE_ICONS[previewTileResources.get(`${r - 1},${c - 1}`)![0]].color"
									class="absolute"
									style="top: 15%; left: 15%"
								/>
								<component
									:is="RESOURCE_ICONS[previewTileResources.get(`${r - 1},${c - 1}`)![1]].icon"
									:size="16"
									:class="RESOURCE_ICONS[previewTileResources.get(`${r - 1},${c - 1}`)![1]].color"
									class="absolute"
									style="bottom: 15%; right: 15%"
								/>
							</template>
						</template>
					</div>
				</template>
			</div>

			<div class="flex items-center gap-1">
				<button
					class="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-sm hover:bg-slate-700 transition-colors flex items-center justify-center"
					title="Rotate counter-clockwise"
					@click="cycleRotation(-1)"
				>
					&#x21BA;
				</button>
				<span class="text-xs text-slate-500 w-8 text-center">{{ rotation }}&deg;</span>
				<button
					class="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-sm hover:bg-slate-700 transition-colors flex items-center justify-center"
					title="Rotate clockwise"
					@click="cycleRotation(1)"
				>
					&#x21BB;
				</button>
			</div>
		</div>

		<!-- Era Start: civilisation card choice -->
		<div v-if="isEraStart && isMyTurn" class="w-full p-3 md:p-4 bg-slate-800 border border-green-600/50 rounded-xl">
			<template v-if="currentEra === 'I'">
				<h3 class="text-sm font-medium text-green-300 mb-2">Reveal your Civilisation Card</h3>
				<div v-if="myEraCard" class="flex items-center gap-4">
					<div
						class="w-[90px] h-[126px] rounded-lg border-2 text-xs font-medium shrink-0 flex flex-col justify-between p-2"
						:class="[BACK_COLOR_CLASSES[myEraCard.backColor], BACK_COLOR_BORDER[myEraCard.backColor]]"
					>
						<div>
							<div class="text-white/90 leading-tight text-[10px] font-semibold">{{ myEraCard.name }}</div>
							<div v-if="myEraCard.description" class="text-white/60 text-[8px] leading-tight mt-1">{{ myEraCard.description }}</div>
						</div>
						<div class="text-white/40 text-[9px]">#{{ myEraCard.number }}</div>
					</div>
					<button
						class="px-4 py-2 rounded-lg bg-green-700 hover:bg-green-600 text-white text-sm font-medium transition-colors"
						@click="onChooseCivCard(false)"
					>
						Reveal &amp; Confirm
					</button>
				</div>
			</template>

			<template v-else>
				<h3 class="text-sm font-medium text-green-300 mb-2">Choose your Civilisation Card</h3>
				<p class="text-xs text-slate-400 mb-3">
					Keep your current card or switch to the new Era {{ currentEra }} card. You may only have one.
				</p>
				<div class="flex items-start gap-6">
					<div v-if="myActiveCivCard" class="flex flex-col items-center gap-2">
						<span class="text-[10px] text-slate-500 uppercase tracking-wide">Current</span>
						<div
							class="w-[90px] h-[126px] rounded-lg border-2 text-xs font-medium shrink-0 flex flex-col justify-between p-2"
							:class="[BACK_COLOR_CLASSES[myActiveCivCard.backColor], BACK_COLOR_BORDER[myActiveCivCard.backColor]]"
						>
							<div>
								<div class="text-white/90 leading-tight text-[10px] font-semibold">{{ myActiveCivCard.name }}</div>
								<div v-if="myActiveCivCard.description" class="text-white/60 text-[8px] leading-tight mt-1">
									{{ myActiveCivCard.description }}
								</div>
							</div>
							<div class="text-white/40 text-[9px]">#{{ myActiveCivCard.number }}</div>
						</div>
						<button
							class="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-medium transition-colors"
							@click="onChooseCivCard(true)"
						>
							Keep Current
						</button>
					</div>

					<div v-if="myEraCard" class="flex flex-col items-center gap-2">
						<span class="text-[10px] text-slate-500 uppercase tracking-wide">New (Era {{ currentEra }})</span>
						<div
							class="w-[90px] h-[126px] rounded-lg border-2 text-xs font-medium shrink-0 flex flex-col justify-between p-2"
							:class="[BACK_COLOR_CLASSES[myEraCard.backColor], BACK_COLOR_BORDER[myEraCard.backColor]]"
						>
							<div>
								<div class="text-white/90 leading-tight text-[10px] font-semibold">{{ myEraCard.name }}</div>
								<div v-if="myEraCard.description" class="text-white/60 text-[8px] leading-tight mt-1">
									{{ myEraCard.description }}
								</div>
							</div>
							<div class="text-white/40 text-[9px]">#{{ myEraCard.number }}</div>
						</div>
						<button
							class="px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 text-white text-xs font-medium transition-colors"
							@click="onChooseCivCard(false)"
						>
							Switch to New
						</button>
					</div>
				</div>
			</template>
		</div>

		<!-- Board area: left panel (Agora + Judgement) | Board with score track | right panel (Wonders + Buildings) -->
		<div class="flex flex-col md:flex-row gap-3 md:gap-4 items-center md:items-start justify-center w-full">
			<!-- Left panel: Agora + Judgement cards -->
			<div
				class="flex flex-row md:flex-col gap-2 shrink-0 md:self-start order-2 md:order-none overflow-x-auto md:overflow-visible w-full md:w-auto"
			>
				<!-- Agora -->
				<div
					class="w-[80px] h-[80px] rounded-lg border-2 border-amber-600/50 bg-amber-900/20 flex flex-col items-center justify-center gap-1"
				>
					<h3 class="text-[10px] font-medium text-amber-300 tracking-wide uppercase">Agora</h3>
					<div class="flex flex-wrap items-center justify-center gap-0">
						<template v-if="agoraWorkers.length === 0">
							<span class="text-[9px] text-slate-500 italic">Empty</span>
						</template>
						<IconMeeple
							v-for="piece in agoraWorkers"
							:key="piece.id"
							:size="20"
							class="-mx-0.5"
							:class="PIECE_COLOR_CLASSES[pieceColor(piece)]"
							stroke-width="2.5"
							:title="`${pieceColor(piece)} worker`"
						/>
					</div>
				</div>

				<!-- History's Judgement cards -->
				<div
					v-for="card in historyCards"
					:key="card.id"
					class="w-[80px] h-[112px] rounded-lg border-2 bg-gray-700 border-gray-500 text-xs font-medium flex flex-col justify-between p-2"
					:title="card.description"
				>
					<div>
						<div class="text-amber-300 font-bold leading-tight text-[9px]">{{ card.name }}</div>
						<div class="text-gray-400 leading-tight text-[7px] mt-0.5">{{ card.description }}</div>
					</div>
					<div class="text-gray-500 text-[7px]">Judgement</div>
				</div>
			</div>

			<!-- Board with score track -->
			<div class="order-1 md:order-none w-full md:w-auto overflow-x-auto md:overflow-x-visible">
				<div class="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden flex flex-col min-w-fit">
					<!-- Top edge of score track (0 at left → 30 at right) -->
					<div class="flex">
						<div
							v-for="pos in topEdgeCells"
							:key="`t${pos}`"
							class="flex-1 h-9 flex items-center justify-center relative bg-slate-900/50 border-b border-r border-slate-700/30 last:border-r-0"
						>
							<span v-if="showTrackNumber(pos)" class="text-[10px] text-slate-500 leading-none font-medium">{{ pos }}</span>
							<div v-if="playersAtTrackPosition.has(pos)" class="absolute bottom-0.5 grid grid-cols-2 gap-px">
								<div
									v-for="color in playersAtTrackPosition.get(pos)"
									:key="color"
									class="w-3 h-3 rounded-full"
									:class="PLAYER_COLOR_CLASSES[color]"
								/>
							</div>
						</div>
					</div>

					<!-- Middle: left track + board + right track -->
					<div class="flex">
						<!-- Left edge (99 at top → 81 at bottom) -->
						<div class="flex flex-col w-9 shrink-0">
							<div
								v-for="pos in leftEdgeCells"
								:key="`l${pos}`"
								class="flex-1 flex items-center justify-center relative bg-slate-900/50 border-b border-r border-slate-700/30 last:border-b-0"
							>
								<span v-if="showTrackNumber(pos)" class="text-[10px] text-slate-500 leading-none font-medium">{{ pos }}</span>
								<div v-if="playersAtTrackPosition.has(pos)" class="absolute bottom-0.5 grid grid-cols-2 gap-px">
									<div
										v-for="color in playersAtTrackPosition.get(pos)"
										:key="color"
										class="w-3 h-3 rounded-full"
										:class="PLAYER_COLOR_CLASSES[color]"
									/>
								</div>
							</div>
						</div>

						<!-- Board -->
						<div class="p-1 relative">
							<div class="absolute inset-0 opacity-10" style="background: url('/images/water-bg.jpg') center / cover no-repeat" />
							<SquareGrid :board="G.board" :cell-size="96" @cell-click="onCellClick">
								<template #cell="{ row, col }">
									<div
										class="w-full h-full flex flex-col items-center justify-center rounded-sm transition-colors relative"
										:class="cellClasses(row, col)"
										:style="{ cursor: cellHasPointer(row, col) ? 'pointer' : 'default' }"
										@mouseenter="onCellHover(row, col)"
										@mouseleave="onCellLeave"
									>
										<!-- Water edge indicators -->
										<div
											v-if="cellWaterEdges(row, col)[0]"
											class="absolute top-0 left-0 right-0 h-[3px] bg-blue-400/70 pointer-events-none z-10"
										/>
										<div
											v-if="cellWaterEdges(row, col)[1]"
											class="absolute top-0 right-0 bottom-0 w-[3px] bg-blue-400/70 pointer-events-none z-10"
										/>
										<div
											v-if="cellWaterEdges(row, col)[2]"
											class="absolute bottom-0 left-0 right-0 h-[3px] bg-blue-400/70 pointer-events-none z-10"
										/>
										<div
											v-if="cellWaterEdges(row, col)[3]"
											class="absolute top-0 left-0 bottom-0 w-[3px] bg-blue-400/70 pointer-events-none z-10"
										/>
										<!-- <span
										v-if="isStartingTileLabel(row, col)"
										class="text-amber-300/60 text-xs font-medium pointer-events-none select-none"
										>Start</span
									> -->

										<template v-if="resourcesAt(row, col).length === 1 && !previewCells.has(`${row},${col}`)">
											<div class="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
												<component
													:is="RESOURCE_ICONS[resourcesAt(row, col)[0]].icon"
													:size="28"
													:class="RESOURCE_ICONS[resourcesAt(row, col)[0]].color"
												/>
											</div>
										</template>
										<template v-else-if="resourcesAt(row, col).length === 2 && !previewCells.has(`${row},${col}`)">
											<component
												:is="RESOURCE_ICONS[resourcesAt(row, col)[0]].icon"
												:size="22"
												:class="RESOURCE_ICONS[resourcesAt(row, col)[0]].color"
												class="absolute pointer-events-none select-none"
												style="top: 18%; left: 18%"
											/>
											<component
												:is="RESOURCE_ICONS[resourcesAt(row, col)[1]].icon"
												:size="22"
												:class="RESOURCE_ICONS[resourcesAt(row, col)[1]].color"
												class="absolute pointer-events-none select-none"
												style="bottom: 18%; right: 18%"
											/>
										</template>

										<template v-if="previewCells.has(`${row},${col}`) && boardPreviewResources.has(`${row},${col}`)">
											<template v-if="boardPreviewResources.get(`${row},${col}`)!.length === 1">
												<div class="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
													<component
														:is="RESOURCE_ICONS[boardPreviewResources.get(`${row},${col}`)![0]].icon"
														:size="28"
														:class="RESOURCE_ICONS[boardPreviewResources.get(`${row},${col}`)![0]].color"
														class="opacity-80"
													/>
												</div>
											</template>
											<template v-else>
												<component
													:is="RESOURCE_ICONS[boardPreviewResources.get(`${row},${col}`)![0]].icon"
													:size="22"
													:class="RESOURCE_ICONS[boardPreviewResources.get(`${row},${col}`)![0]].color"
													class="absolute pointer-events-none select-none opacity-80"
													style="top: 18%; left: 18%"
												/>
												<component
													:is="RESOURCE_ICONS[boardPreviewResources.get(`${row},${col}`)![1]].icon"
													:size="22"
													:class="RESOURCE_ICONS[boardPreviewResources.get(`${row},${col}`)![1]].color"
													class="absolute pointer-events-none select-none opacity-80"
													style="bottom: 18%; right: 18%"
												/>
											</template>
										</template>

										<template v-if="piecesAt(row, col).length > 0 || citiesAt(row, col).length > 0">
											<!-- Capital: top-left -->
											<template v-for="piece in piecesAt(row, col).filter((p) => p.type === 'capital')" :key="piece.id">
												<IconHexagon
													:size="20"
													class="absolute pointer-events-none select-none"
													:class="[PIECE_FILL_CLASSES[pieceColor(piece)], PIECE_STROKE_CLASSES[pieceColor(piece)]]"
													style="top: 4px; left: 4px"
													stroke-width="2.5"
													:title="`Capital (${pieceColor(piece)})`"
												/>
											</template>

											<!-- City cubes: top-right, stacked downward -->
											<div
												v-if="citiesAt(row, col).length > 0"
												class="absolute flex flex-col gap-0.5 pointer-events-none select-none"
												style="top: 4px; right: 4px"
											>
												<template v-for="city in citiesAt(row, col)" :key="`city-${city.owner}`">
													<div
														v-for="n in city.cubes"
														:key="n"
														class="w-3 h-3 rounded-[2px] flex items-center justify-center text-[6px] text-white font-bold"
														:class="CUBE_BG_CLASSES[PLAYER_COLORS[parseInt(city.owner, 10)]]"
														:title="`City cube ${n}/${city.cubes} (${PLAYER_COLORS[parseInt(city.owner, 10)]})`"
													>
														{{ n }}
													</div>
												</template>
											</div>

											<!-- Workers: bottom row, centered -->
											<div
												v-if="piecesAt(row, col).some((p) => p.type === 'worker')"
												class="absolute bottom-0 left-0 right-0 flex items-end justify-center gap-0 select-none"
												:class="isSelectingWorker ? 'pointer-events-auto' : 'pointer-events-none'"
												style="bottom: 0px"
											>
												<IconMeeple
													v-for="piece in piecesAt(row, col).filter((p) => p.type === 'worker')"
													:key="piece.id"
													:size="22"
													class="-mx-0.5 transition-all"
													:class="[
														PIECE_COLOR_CLASSES[pieceColor(piece)],
														isWorkerSelectable(piece)
															? 'cursor-pointer hover:scale-125 hover:drop-shadow-[0_0_6px_rgba(255,255,255,0.5)]'
															: piece.exhausted
															? 'opacity-40'
															: '',
													]"
													stroke-width="2.5"
													:title="`Worker (${pieceColor(piece)})${piece.exhausted ? ' - exhausted' : ''}`"
												/>
											</div>
										</template>
									</div>
								</template>
							</SquareGrid>
						</div>

						<!-- Right edge (31 at top → 50 at bottom) -->
						<div class="flex flex-col w-9 shrink-0">
							<div
								v-for="pos in rightEdgeCells"
								:key="`r${pos}`"
								class="flex-1 flex items-center justify-center relative bg-slate-900/50 border-b border-l border-slate-700/30 last:border-b-0"
							>
								<span v-if="showTrackNumber(pos)" class="text-[10px] text-slate-500 leading-none font-medium">{{ pos }}</span>
								<div v-if="playersAtTrackPosition.has(pos)" class="absolute bottom-0.5 grid grid-cols-2 gap-px">
									<div
										v-for="color in playersAtTrackPosition.get(pos)"
										:key="color"
										class="w-3 h-3 rounded-full"
										:class="PLAYER_COLOR_CLASSES[color]"
									/>
								</div>
							</div>
						</div>
					</div>

					<!-- Bottom edge of score track (80 at left → 51 at right) -->
					<div class="flex">
						<div
							v-for="pos in bottomEdgeCells"
							:key="`b${pos}`"
							class="flex-1 h-9 flex items-center justify-center relative bg-slate-900/50 border-t border-r border-slate-700/30 last:border-r-0"
						>
							<span v-if="showTrackNumber(pos)" class="text-[10px] text-slate-500 leading-none font-medium">{{ pos }}</span>
							<div v-if="playersAtTrackPosition.has(pos)" class="absolute bottom-0.5 grid grid-cols-2 gap-px">
								<div
									v-for="color in playersAtTrackPosition.get(pos)"
									:key="color"
									class="w-3 h-3 rounded-full"
									:class="PLAYER_COLOR_CLASSES[color]"
								/>
							</div>
						</div>
					</div>
				</div>
			</div>

			<!-- Right panel: Wonders + Buildings -->
			<div
				v-if="availableWonders.length > 0 || availableBuildings.length > 0"
				class="flex flex-col md:flex-row gap-2 shrink-0 md:self-start order-3 md:order-none overflow-x-auto md:overflow-visible w-full md:w-auto"
			>
				<!-- Wonders -->
				<div v-if="availableWonders.length > 0" class="flex flex-row md:flex-col gap-2">
					<div
						v-for="card in availableWonders"
						:key="card.id"
						class="w-[80px] h-[112px] rounded-lg border-2 text-xs font-medium flex flex-col justify-between p-2 transition-all"
						:class="[
							(selectingWonder || canDoAction('buildWonder')) && canAffordWonder(card)
								? 'bg-purple-900/60 border-purple-400 ring-2 ring-purple-400/50 cursor-pointer hover:ring-purple-300'
								: hasWonderDiscount(card) || isGreeceFreeAvailable
								? 'bg-purple-900/60 border-amber-500/70 ring-1 ring-amber-400/30'
								: 'bg-purple-900/60 border-purple-500',
						]"
						:title="card.description"
						@click="onClickWonderCard(card.id)"
					>
						<div>
							<div class="text-purple-200 leading-tight text-[10px] font-semibold">{{ card.name }}</div>
							<div v-if="card.description" class="text-purple-300/60 text-[8px] leading-tight mt-0.5">{{ card.description }}</div>
						</div>
						<div>
							<div class="flex items-center justify-between">
								<span class="text-[10px] font-bold" :class="hasWonderDiscount(card) ? 'text-green-400' : 'text-amber-400'"
									>{{ getWonderCost(card) }}g</span
								>
								<span v-if="hasWonderDiscount(card)" class="text-purple-500/60 text-[8px] line-through">{{ card.wonderCost }}g</span>
							</div>
							<div v-if="isGreeceFreeAvailable" class="text-green-400/80 text-[7px] leading-tight mt-0.5">✦ Greece: Free</div>
							<div v-else-if="hasWonderDiscount(card)" class="text-amber-400/70 text-[7px] leading-tight mt-0.5">
								✦ {{ CIV_DISPLAY_NAMES[card.wonderDiscountCiv!] ?? card.wonderDiscountCiv }}
							</div>
						</div>
					</div>
				</div>

				<!-- Buildings -->
				<div v-if="availableBuildings.length > 0" class="flex flex-row md:flex-col gap-2">
					<div
						v-for="card in availableBuildings"
						:key="card.id"
						class="w-[80px] h-[112px] rounded-lg border-2 text-xs font-medium flex flex-col justify-between p-2 transition-all"
						:class="
							(agoraAction === 'builder' && agoraWorkerId) || canDoAction('builder')
								? 'bg-orange-900/60 border-orange-400 ring-2 ring-orange-400/50 cursor-pointer hover:ring-orange-300'
								: 'bg-orange-900/60 border-orange-500'
						"
						:title="card.description ?? ''"
						@click="onSelectBuildingCard(card.id)"
					>
						<div>
							<div class="text-orange-200 leading-tight text-[10px] font-semibold">{{ card.name }}</div>
							<div v-if="card.description" class="text-orange-300/50 text-[8px] leading-tight mt-0.5">{{ card.description }}</div>
						</div>
						<div class="text-orange-400/60 text-[9px]">Building</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Player Board -->
		<div
			v-if="viewedPlayer"
			class="w-full bg-slate-800 border-2 rounded-xl overflow-hidden"
			:class="isViewingSelf ? PLAYER_COLOR_BORDER[viewedPlayer.color] : 'border-slate-700'"
		>
			<!-- Header: arrows + player info + resources -->
			<div class="flex flex-wrap items-center gap-2 md:gap-3 px-3 md:px-4 py-2 md:py-3 border-b border-slate-700/50">
				<button
					class="w-7 h-7 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-white text-sm flex items-center justify-center transition-colors"
					@click="cyclePlayer(-1)"
				>
					&lsaquo;
				</button>

				<div class="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
					<div class="w-3 h-3 rounded-full shrink-0" :class="PLAYER_COLOR_CLASSES[viewedPlayer.color]" />
					<span class="font-medium capitalize" :class="PLAYER_COLOR_TEXT[viewedPlayer.color]">{{ viewedPlayer.color }}</span>
					<span v-if="viewedPlayer.passedThisEra" class="text-[10px] px-1.5 py-0.5 rounded bg-amber-800/60 text-amber-300 font-medium"
						>Golden Age</span
					>
					<span v-if="isViewingSelf" class="text-slate-500 text-xs">(You)</span>
					<span
						v-if="isViewedPlayersTurn"
						class="text-[10px] px-1.5 py-0.5 rounded font-medium animate-pulse"
						:class="isViewingSelf ? 'bg-emerald-800/60 text-emerald-300' : 'bg-blue-800/60 text-blue-300'"
						>{{ isViewingSelf ? "Your Turn" : "Active Turn" }}</span
					>
					<span
						v-if="isTechSelectionActive"
						class="inline-flex items-center gap-2 text-[10px] px-2 py-0.5 rounded bg-amber-800/40 text-amber-300 font-medium ml-2"
					>
						<template v-if="japanTechQueue.length > 0">
							{{ japanTechQueue.length }} tech{{ japanTechQueue.length > 1 ? "s" : "" }} queued ({{ japanQueuedGold }}g)
							<button
								class="text-green-400 hover:text-green-300 cursor-pointer transition-colors text-xs font-bold leading-none"
								@click="onConfirmJapanTechs"
							>
								Confirm
							</button>
						</template>
						<template v-else-if="oxfordTechPending">
							Oxford University: select {{ 2 - oxfordTechQueue.length }} more tech{{ 2 - oxfordTechQueue.length > 1 ? "s" : "" }} (free)
							<button
								v-if="oxfordTechQueue.length > 0"
								class="text-green-400 hover:text-green-300 cursor-pointer transition-colors text-xs font-bold leading-none"
								@click="onConfirmOxford"
							>
								Confirm
							</button>
						</template>
						<template v-else>
							{{
								greatLibraryTechPending
									? "Select a technology (free - Great Library)"
									: activatingTechSlot !== null
									? activatingTechDiscount >= 99
										? "Select a technology (free)"
										: `Select a technology (${activatingTechDiscount}g discount)`
									: japanDiscount > 0
									? `Select technologies (-${japanDiscount}g each)`
									: "Select a technology"
							}}
						</template>
						<button
							class="text-amber-500 hover:text-red-400 cursor-pointer transition-colors text-sm leading-none"
							@click="onCancelTechSelect"
						>
							&times;
						</button>
					</span>
					<span
						v-if="explorerPhase === 'selectWorker'"
						class="inline-flex items-center gap-2 text-[10px] px-2 py-0.5 rounded bg-cyan-800/40 text-cyan-300 font-medium ml-2"
					>
						Select a worker
						<button class="text-cyan-500 hover:text-red-400 cursor-pointer transition-colors text-sm leading-none" @click="resetExplorer">
							&times;
						</button>
					</span>
					<span
						v-if="explorerPhase === 'selectDest'"
						class="inline-flex items-center gap-2 text-[10px] px-2 py-0.5 rounded bg-cyan-800/40 text-cyan-300 font-medium ml-2"
					>
						Select destination
						<button class="text-cyan-500 hover:text-red-400 cursor-pointer transition-colors text-sm leading-none" @click="resetExplorer">
							&times;
						</button>
					</span>
					<span
						v-if="soldierPhase === 'selectWorker'"
						class="inline-flex items-center gap-2 text-[10px] px-2 py-0.5 rounded bg-red-800/40 text-red-300 font-medium ml-2"
					>
						Select a worker for Soldier
						<button class="text-red-500 hover:text-red-400 cursor-pointer transition-colors text-sm leading-none" @click="resetSoldier">
							&times;
						</button>
					</span>
					<span
						v-if="soldierPhase === 'selectDest'"
						class="inline-flex items-center gap-2 text-[10px] px-2 py-0.5 rounded bg-red-800/40 text-red-300 font-medium ml-2"
					>
						Select target
						<button class="text-red-500 hover:text-red-400 cursor-pointer transition-colors text-sm leading-none" @click="resetSoldier">
							&times;
						</button>
					</span>
					<span
						v-if="agoraAction"
						class="inline-flex items-center gap-2 text-[10px] px-2 py-0.5 rounded bg-amber-800/40 text-amber-300 font-medium ml-2"
					>
						<template v-if="agoraAction === 'builder' && agoraWorkerId"> Select a building card from the display </template>
						<template v-else> Select a worker for {{ agoraAction === "artist" ? "Artist" : "Builder" }} </template>
						<button class="text-amber-500 hover:text-red-400 cursor-pointer transition-colors text-sm leading-none" @click="resetAgora">
							&times;
						</button>
					</span>
					<span
						v-if="isActivating"
						class="inline-flex items-center gap-2 text-[10px] px-2 py-0.5 rounded bg-green-800/40 text-green-300 font-medium ml-2"
					>
						<template v-if="activatingTechSlot !== null">
							Select a technology ({{ activatingTechDiscount >= 99 ? "free" : `${activatingTechDiscount}g discount` }})
						</template>
						<template v-else-if="activatingFactory !== null"> Select an exhausted worker on the map to reactivate </template>
						<template v-else-if="notreDamePending !== null">
							Notre Dame:
							<button
								class="px-2 py-0.5 rounded bg-purple-700/50 hover:bg-purple-600/50 text-purple-200 cursor-pointer transition-colors"
								@click="onNotreDameChoice(0)"
							>
								Map → Agora
							</button>
							<button
								class="px-2 py-0.5 rounded bg-purple-700/50 hover:bg-purple-600/50 text-purple-200 cursor-pointer transition-colors"
								@click="onNotreDameChoice(1)"
							>
								Agora → Capital
							</button>
						</template>
						<template v-else> Select a building or wonder to activate </template>
						<button
							class="text-green-500 hover:text-red-400 cursor-pointer transition-colors text-sm leading-none"
							@click="resetActivate"
						>
							&times;
						</button>
					</span>
					<span
						v-if="selectingWonder && !isWonderTechActive"
						class="inline-flex items-center gap-2 text-[10px] px-2 py-0.5 rounded bg-purple-800/40 text-purple-300 font-medium ml-2"
					>
						Select a wonder to build
						<button
							class="text-purple-400 hover:text-red-400 cursor-pointer transition-colors text-sm leading-none"
							@click="cancelWonderSelect"
						>
							&times;
						</button>
					</span>
				</div>

				<div class="flex items-center gap-2 md:gap-3 text-base text-slate-400 shrink-0">
					<span class="inline-flex items-center gap-0.5" title="Gold"
						><IconCoin :size="14" class="text-amber-400 mr-1" />
						<span class="text-amber-400 font-medium">{{ viewedPlayer.gold ?? 0 }}</span></span
					>
					<span class="inline-flex items-center gap-0.5" title="Cubes"
						><IconSquareFilled :size="12" class="text-slate-300 mr-1" /> {{ viewedPlayer.cubes ?? 0 }}</span
					>
					<span
						class="inline-flex items-center gap-0.5"
						:title="`Workers: ${viewedWorkerStatus.available} available / ${viewedWorkerStatus.exhausted} exhausted`"
						><IconMeeple :size="14" class="text-slate-400 mr-1" /> {{ viewedWorkerStatus.available }}/{{ viewedWorkerStatus.total }}</span
					>
					<span
						class="inline-flex items-center gap-0.5"
						:title="`Glory: ${(viewedPlayer?.gloryTokens ?? []).length} tokens (${(viewedPlayer?.gloryTokens ?? []).reduce((s: number, v: number) => s + v, 0)} pts)`"
						><IconLaurelWreath :size="14" class="text-slate-400 mr-1" />
						{{ (viewedPlayer?.gloryTokens ?? []).reduce((s: number, v: number) => s + v, 0) }}</span
					>
					<span class="hidden md:inline text-slate-600">|</span>
					<span
						v-for="res in (['gem', 'rock', 'game', 'wheat'] as ResourceType[])"
						:key="res"
						class="inline-flex items-center gap-0.5"
						:title="res"
					>
						<component :is="RESOURCE_ICONS[res].icon" :size="13" :class="RESOURCE_ICONS[res].color" />
						<span class="ml-1 text-slate-300 font-medium w-2.5 text-right">{{ viewedResourceCounts[res] }}</span>
					</span>
				</div>

				<button
					class="w-7 h-7 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-white text-sm flex items-center justify-center transition-colors"
					@click="cyclePlayer(1)"
				>
					&rsaquo;
				</button>
			</div>

			<!-- Bottom third: cards + invasion track + actions in one row -->
			<div class="px-3 md:px-4 pt-1.5 md:pt-2 border-b mb-0 pb-2 border-slate-700/50">
				<div class="flex gap-2 items-center overflow-x-auto">
					<!-- Building slots -->
					<div
						v-for="(_, slotIdx) in 3"
						:key="`bslot-${slotIdx}`"
						class="w-[72px] h-[100px] rounded-lg border-2 flex flex-col items-center justify-center relative transition-all shrink-0"
						:class="[
							viewedPlayer?.builtBuildings?.[slotIdx]
								? viewedPlayer.activatedBuildings?.[slotIdx] &&
								  !PASSIVE_BUILDINGS.has(viewedPlayer.builtBuildings[slotIdx]?.buildingType ?? '')
									? 'border-orange-500/30 bg-orange-900/10 opacity-50'
									: activatingBuilding &&
									  isViewingSelf &&
									  !viewedPlayer.activatedBuildings?.[slotIdx] &&
									  !PASSIVE_BUILDINGS.has(viewedPlayer.builtBuildings[slotIdx]?.buildingType ?? '')
									? 'border-green-400 bg-green-900/30 ring-2 ring-green-400/50 cursor-pointer hover:ring-green-300'
									: 'border-orange-500/60 bg-orange-900/20'
								: viewedBuildingSlots[slotIdx]
								? 'border-dashed border-slate-500/60 bg-slate-700/30'
								: 'border-dashed border-slate-700/40 bg-slate-800/30 opacity-40',
						]"
						@click="activatingBuilding && viewedPlayer?.builtBuildings?.[slotIdx] && isViewingSelf ? onActivateSlot(slotIdx) : undefined"
					>
						<template v-if="viewedPlayer?.builtBuildings?.[slotIdx]">
							<span
								class="text-[10px] font-medium text-center px-1 leading-tight"
								:class="
									viewedPlayer.activatedBuildings?.[slotIdx] &&
									!PASSIVE_BUILDINGS.has(viewedPlayer.builtBuildings[slotIdx]?.buildingType ?? '')
										? 'text-orange-500/50'
										: 'text-orange-300'
								"
							>
								{{ viewedPlayer.builtBuildings[slotIdx]!.name }}
							</span>
							<span
								v-if="viewedPlayer.builtBuildings[slotIdx]!.description"
								class="text-[8px] text-center px-1 leading-tight mt-0.5"
								:class="
									viewedPlayer.activatedBuildings?.[slotIdx] &&
									!PASSIVE_BUILDINGS.has(viewedPlayer.builtBuildings[slotIdx]?.buildingType ?? '')
										? 'text-slate-600'
										: 'text-slate-400'
								"
							>
								{{ viewedPlayer.builtBuildings[slotIdx]!.description }}
							</span>
							<span
								v-if="PASSIVE_BUILDINGS.has(viewedPlayer.builtBuildings[slotIdx]?.buildingType ?? '')"
								class="text-[8px] text-blue-400/60 mt-1 font-medium"
								>Permanent</span
							>
							<span v-else-if="viewedPlayer.activatedBuildings?.[slotIdx]" class="text-[8px] text-green-400/60 mt-1 font-medium"
								>Used</span
							>
						</template>
						<template v-else-if="viewedBuildingSlots[slotIdx]">
							<span class="text-[10px] text-slate-500">Empty</span>
						</template>
						<template v-else>
							<IconLock :size="16" class="text-slate-600" />
							<span class="text-[9px] text-slate-600 mt-0.5">Locked</span>
						</template>
					</div>

					<!-- Built wonders -->
					<template v-if="viewedPlayer?.builtWonders?.length">
						<div
							v-for="(wonder, wIdx) in viewedPlayer.builtWonders"
							:key="`wonder-${wIdx}`"
							class="w-[72px] h-[100px] rounded-lg border-2 flex flex-col items-center justify-center p-1.5 transition-all shrink-0"
							:class="
								activatingBuilding && isViewingSelf && wonderActivatable(wonder, wIdx)
									? 'border-green-400 bg-purple-900/30 ring-2 ring-green-400/50 cursor-pointer hover:ring-green-300'
									: wonderHasActivate(wonder) && !wonderActivatable(wonder, wIdx)
									? 'border-purple-500/30 bg-purple-900/10 opacity-50'
									: 'border-purple-500/60 bg-purple-900/20'
							"
							@click="activatingBuilding && isViewingSelf ? onActivateWonder(wIdx) : undefined"
						>
							<span class="text-[10px] font-medium text-center px-1 leading-tight text-purple-300">
								{{ wonder.name }}
							</span>
							<span v-if="wonder.description" class="text-[8px] text-center px-1 leading-tight mt-0.5 text-slate-400">
								{{ wonder.description }}
							</span>
							<span
								v-if="wonderHasActivate(wonder) && !wonderActivatable(wonder, wIdx)"
								class="text-[8px] text-green-400/60 mt-1 font-medium"
								>Used</span
							>
							<span v-else-if="wonderActivatable(wonder, wIdx)" class="text-[8px] text-purple-400/60 mt-1 font-medium">Activate</span>
						</div>
					</template>

					<!-- Active civilisation card -->
					<div v-if="viewedCivCard" class="shrink-0 pl-2 border-l border-slate-700/40">
						<div
							class="w-[72px] h-[100px] rounded-lg border text-xs font-medium flex flex-col justify-between p-1.5"
							:class="[BACK_COLOR_CLASSES[viewedCivCard.backColor], BACK_COLOR_BORDER[viewedCivCard.backColor]]"
							:title="viewedCivCard.description ?? ''"
						>
							<div>
								<div class="text-white/90 leading-tight text-[9px] font-semibold">{{ viewedCivCard.name }}</div>
								<div v-if="viewedCivCard.description" class="text-white/50 text-[7px] leading-tight mt-0.5">
									{{ viewedCivCard.description }}
								</div>
							</div>
							<div class="text-white/30 text-[8px]">Era {{ viewedCivCard.era }}</div>
						</div>
					</div>

					<!-- Spacer to push actions right -->
					<div class="flex-1" />

					<!-- Invasion track + Action icons (right-aligned, stacked) -->
					<div class="flex flex-col items-stretch gap-2.5 shrink-0 pl-1 border-l border-slate-700/40">
						<!-- Invasion track -->
						<div class="flex items-center justify-between gap-0.5">
							<template v-for="(cost, idx) in INVASION_COSTS" :key="`inv-${idx}`">
								<IconChevronRight class="text-slate-500 shrink-0" :size="14" />
								<div
									class="w-7 h-7 rounded border flex items-center justify-center text-sm font-bold shrink-0 transition-colors"
									:class="
										idx < (viewedPlayer?.invasionTrackPos ?? 0)
											? 'border-slate-700/40 bg-slate-800/30 text-slate-600 line-through'
											: idx === (viewedPlayer?.invasionTrackPos ?? 0)
											? 'border-red-500/60 bg-red-900/30 text-red-400'
											: 'border-slate-600 bg-slate-700/50 text-amber-400'
									"
								>
									{{ cost }}
								</div>
							</template>
						</div>

						<!-- Action icons -->
						<div v-if="!activePrompt" class="flex items-center gap-3">
							<!-- Worker actions group -->
							<div class="flex items-center gap-1.5">
								<IconMeeple :size="20" class="text-slate-500 shrink-0" title="Requires a worker" />
								<div class="grid grid-cols-2 gap-1">
									<button
										v-for="action in ACTION_TYPES.slice(0, 4)"
										:key="action.type"
										class="w-8 h-8 rounded border flex items-center justify-center transition-colors"
										:class="
											canDoAction(action.type)
												? 'bg-slate-700/50 border-slate-600/50 hover:bg-slate-600/50 text-slate-200 cursor-pointer'
												: 'bg-slate-800/40 border-slate-700/30 text-slate-500 cursor-default'
										"
										:disabled="!canDoAction(action.type)"
										:title="action.label"
										@click="canDoAction(action.type) && onAction(action.type)"
									>
										<component :is="ACTION_ICONS[action.type]" :size="18" />
									</button>
								</div>
							</div>

							<!-- Divider -->
							<div class="w-px h-16 bg-slate-700/40" />

							<!-- Non-worker actions group -->
							<div class="flex items-center gap-1.5">
								<div class="relative shrink-0" title="No worker needed">
									<IconMeeple :size="20" class="text-slate-500" />
									<div class="absolute inset-0 flex items-center justify-center">
										<div class="w-[22px] h-[2px] bg-slate-500 rotate-45" />
									</div>
								</div>
								<div class="grid grid-cols-2 gap-1">
									<button
										v-for="action in ACTION_TYPES.slice(4, 8)"
										:key="action.type"
										class="w-8 h-8 rounded border flex items-center justify-center transition-colors"
										:class="[
											canDoAction(action.type)
												? action.type === 'startGoldenAge'
													? 'bg-amber-900/40 border-amber-600/50 hover:bg-amber-800/50 text-amber-200 cursor-pointer'
													: 'bg-slate-700/50 border-slate-600/50 hover:bg-slate-600/50 text-slate-200 cursor-pointer'
												: 'bg-slate-800/40 border-slate-700/30 text-slate-500 cursor-default',
										]"
										:disabled="!canDoAction(action.type)"
										:title="action.label"
										@click="canDoAction(action.type) && onAction(action.type)"
									>
										<component :is="ACTION_ICONS[action.type]" :size="18" />
									</button>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>

			<!-- Grid area: 5 cols x 4 rows -->
			<div ref="techGridEl" class="p-2 md:p-4 overflow-x-auto">
				<div class="grid gap-1 min-w-[480px]" style="grid-template-columns: repeat(5, 1fr); grid-template-rows: repeat(4, 85px)">
					<template v-for="(row, rIdx) in TECH_TREE" :key="`row-${rIdx}`">
						<div
							v-for="(tech, cIdx) in row"
							:key="`tech-${rIdx}-${cIdx}`"
							class="group rounded-sm px-3 py-2 flex items-start relative overflow-hidden transition-colors border"
							:class="[
								isTechSelectionActive &&
								isViewingSelf &&
								effectiveTechState(rIdx, cIdx) === 'available' &&
								effectiveTechAffordable(rIdx, cIdx)
									? 'cursor-pointer ring-1 ring-amber-400/60 hover:ring-amber-400 hover:opacity-100'
									: '',
								effectiveTechState(rIdx, cIdx) === 'locked' ? 'opacity-50' : '',
								japanTechQueue.some(([r, c]) => r === rIdx && c === cIdx) ? 'ring-2 ring-green-400' : '',
							]"
							:style="{
								gridColumn: cIdx + 1,
								gridRow: rIdx + 1,
								backgroundColor:
									effectiveTechState(rIdx, cIdx) === 'researched'
										? researchedStyle.bg
										: effectiveTechState(rIdx, cIdx) === 'available'
										? '#1e293b'
										: '#0f172a',
								borderColor:
									effectiveTechState(rIdx, cIdx) === 'researched'
										? researchedStyle.border
										: effectiveTechState(rIdx, cIdx) === 'available'
										? '#334155'
										: '#1e293b',
								borderWidth: effectiveTechState(rIdx, cIdx) === 'researched' ? '2px' : '1px',
							}"
							:title="tech.description"
							@click="
								isTechSelectionActive &&
								isViewingSelf &&
								effectiveTechState(rIdx, cIdx) === 'available' &&
								effectiveTechAffordable(rIdx, cIdx)
									? onSelectTech(rIdx, cIdx)
									: undefined
							"
						>
							<span
								v-if="tech.cost > 0 && effectiveTechState(rIdx, cIdx) !== 'researched'"
								class="text-xs font-bold mr-3 shrink-0"
								:class="
									(activatingTechSlot !== null || japanDiscount > 0) && effectiveTechState(rIdx, cIdx) === 'available'
										? 'text-green-400'
										: 'text-amber-400/80'
								"
								>{{
									(activatingTechSlot !== null || japanDiscount > 0) && effectiveTechState(rIdx, cIdx) === "available"
										? Math.max(0, tech.cost - Math.max(activatingTechDiscount, japanDiscount))
										: tech.cost
								}}</span
							>
							<span
								class="text-sm font-semibold leading-tight truncate"
								:class="effectiveTechState(rIdx, cIdx) === 'researched' ? 'text-slate-100' : 'text-slate-300'"
								>{{ tech.name }}</span
							>
							<div v-if="viewedPlayer.boardCubes?.[`${rIdx + 1},${cIdx + 1}`]" class="absolute top-2.5 right-2 flex gap-0.5">
								<div
									v-for="n in viewedPlayer.boardCubes[`${rIdx + 1},${cIdx + 1}`]"
									:key="n"
									class="w-3.5 h-3.5"
									:class="PLAYER_COLOR_CLASSES[viewedPlayer.color]"
								/>
							</div>
							<div
								class="hidden group-hover:flex absolute z-10 left-0 top-full mt-1 px-2 py-1.5 bg-slate-900 border border-slate-600 rounded shadow-lg text-[10px] text-slate-300 leading-snug whitespace-normal max-w-[200px] pointer-events-none"
							>
								{{ tech.description }}
							</div>
						</div>
					</template>
				</div>
			</div>
		</div>

		<!-- Spacer so content doesn't hide behind the pinned hand -->
		<div v-if="myPlayer?.hand?.length" class="h-32" />
	</div>

	<!-- Pinned hand at the bottom of the viewport -->
	<div
		v-if="myPlayer?.hand?.length"
		class="fixed bottom-0 left-0 right-0 z-40 bg-slate-900/95 border-t border-slate-700 backdrop-blur-sm px-3 md:px-6 py-2 md:py-3"
	>
		<div class="max-w-5xl mx-auto">
			<div class="flex items-center gap-2 md:gap-3 overflow-x-auto">
				<div
					v-for="card in myPlayer.hand"
					:key="card.id"
					class="w-[60px] h-[84px] md:w-[70px] md:h-[98px] rounded-lg border-2 text-xs font-medium shrink-0 flex flex-col justify-between p-1.5 md:p-2"
					:class="[BACK_COLOR_CLASSES[card.backColor], BACK_COLOR_BORDER[card.backColor]]"
					:title="card.description ?? ''"
				>
					<div class="text-white/90 leading-tight text-[10px]">{{ card.name }}</div>
					<div v-if="card.description && card.futureTechType" class="text-white/60 text-[8px] leading-tight">{{ card.description }}</div>
					<div v-else class="text-white/50 text-[9px]">{{ card.era ? `Era ${card.era}` : card.cardType }}</div>
				</div>
			</div>
		</div>
	</div>

	<!-- Game Over overlay: reveal scores one-by-one, then show final standings -->
	<div v-if="gameIsOver && !gameOverDismissed" class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center">
		<div class="bg-slate-800 border border-slate-600 rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4">
			<h2 class="text-2xl font-bold text-amber-300 text-center mb-2">Game Over</h2>
			<p v-if="!allScoresRevealed" class="text-slate-400 text-sm text-center mb-6">Revealing scores…</p>
			<p v-else class="text-amber-200/90 text-sm text-center mb-6 font-medium">Final standings</p>

			<!-- Phase 1: reveal order — one score at a time -->
			<div v-if="!allScoresRevealed" class="space-y-3">
				<div
					v-for="(r, idx) in playersInRevealOrder"
					:key="r.playerId"
					class="flex items-center gap-3 p-3 rounded-lg transition-all duration-300"
					:class="idx < revealedScoresCount ? 'bg-slate-700/60 border border-slate-500/40' : 'bg-slate-800/60 border border-slate-600/20'"
				>
					<span class="text-lg font-bold w-7 text-center text-slate-500">{{ idx + 1 }}</span>
					<div class="w-4 h-4 rounded-full shrink-0" :class="PLAYER_COLOR_CLASSES[G!.players[r.playerId].color]" />
					<span class="font-medium capitalize flex-1" :class="PLAYER_COLOR_TEXT[G!.players[r.playerId].color]">
						{{ G!.players[r.playerId].color }}
					</span>
					<div class="text-right min-w-[100px]">
						<Transition name="score-reveal" mode="out-in">
							<span
								v-if="idx < revealedScoresCount"
								key="score"
								class="text-lg font-bold text-slate-200 tabular-nums"
							>
								{{ r.score }} VP
								<span class="text-xs text-slate-500 ml-1 font-normal">({{ r.cities }} cities)</span>
							</span>
							<span v-else key="hidden" class="text-slate-500 text-lg">—</span>
						</Transition>
					</div>
				</div>
			</div>

			<!-- Phase 2: final rankings with winner highlight -->
			<div v-else class="space-y-3">
				<div
					v-for="(r, idx) in finalRankings"
					:key="r.playerId"
					class="flex items-center gap-3 p-3 rounded-lg transition-all duration-300"
					:class="idx === 0 ? 'bg-amber-900/40 border border-amber-600/40' : 'bg-slate-700/40 border border-slate-600/30'"
				>
					<span class="text-lg font-bold w-7 text-center" :class="idx === 0 ? 'text-amber-300' : 'text-slate-400'">
						{{ idx === 0 ? '★' : idx + 1 }}
					</span>
					<div class="w-4 h-4 rounded-full shrink-0" :class="PLAYER_COLOR_CLASSES[G!.players[r.playerId].color]" />
					<span class="font-medium capitalize flex-1" :class="PLAYER_COLOR_TEXT[G!.players[r.playerId].color]">
						{{ G!.players[r.playerId].color }}
					</span>
					<div class="text-right">
						<span class="text-lg font-bold" :class="idx === 0 ? 'text-amber-200' : 'text-slate-200'"> {{ r.score }} VP </span>
						<span class="text-xs text-slate-500 ml-1">({{ r.cities }} cities)</span>
					</div>
				</div>
			</div>

			<div class="flex justify-center gap-3 mt-6">
				<button
					class="px-5 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-white font-medium transition-colors cursor-pointer"
					@click="$emit('backToLobby')"
				>
					Back to Lobby
				</button>
				<button
					class="px-5 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium transition-colors cursor-pointer"
					@click="gameOverDismissed = true"
				>
					View Board
				</button>
			</div>
		</div>
	</div>
</template>

<style scoped>
.score-reveal-enter-active,
.score-reveal-leave-active {
	transition: opacity 0.25s ease, transform 0.25s ease;
}
.score-reveal-enter-from {
	opacity: 0;
	transform: scale(0.95);
}
.score-reveal-leave-to {
	opacity: 0;
	transform: scale(1.02);
}
</style>
