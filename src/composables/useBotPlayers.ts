import { onUnmounted, watch, type Ref } from 'vue';
import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { getTileAt } from '@noble/bg-engine/client';
import {
	gameDef,
	ERA_TILE_SHAPES,
	ROTATIONS,
	canPlaceGameTile,
	getMovementRange,
	getReachableCells,
	type GoldenAgesState,
	type Era,
	type BoardPiece,
} from '../logic/game-logic';
import type { TileRotation } from '@noble/bg-engine/client';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8000';

interface BotClient {
	playerID: string;
	client: ReturnType<typeof Client>;
	unsubscribe: () => void;
}

function loadBotCredentials(matchID: string): Record<string, string> {
	const key = `bgf:bots:${gameDef.id}:${matchID}`;
	try {
		return JSON.parse(localStorage.getItem(key) || '{}');
	} catch {
		return {};
	}
}

function findRandomValidPlacement(
	G: GoldenAgesState,
	era: Era,
): { row: number; col: number; rotation: TileRotation } | null {
	const shape = ERA_TILE_SHAPES[era];
	const options: { row: number; col: number; rotation: TileRotation }[] = [];

	for (const rot of ROTATIONS) {
		for (let r = 0; r < G.board.rows; r++) {
			for (let c = 0; c < G.board.cols; c++) {
				if (canPlaceGameTile(G.tiles, G.board, shape, r, c, rot)) {
					options.push({ row: r, col: c, rotation: rot });
				}
			}
		}
	}

	if (options.length === 0) return null;
	return options[Math.floor(Math.random() * options.length)];
}

function pickExplorerMove(G: GoldenAgesState, pid: string): { workerId: string; row: number; col: number; foundCity: boolean } | null {
	const player = G.players[pid];
	if (!player) return null;

	const availableWorkers = G.pieces.filter(
		(p: BoardPiece) => p.type === 'worker' && p.owner === pid && !p.exhausted && !p.inAgora,
	);
	if (availableWorkers.length === 0) return null;

	const worker = availableWorkers[Math.floor(Math.random() * availableWorkers.length)];
	const range = getMovementRange(player);
	const reachable = getReachableCells(G.board.rows, G.board.cols, worker.row, worker.col, range);
	if (reachable.length === 0) return null;

	const [destRow, destCol] = reachable[Math.floor(Math.random() * reachable.length)];

	const tile = getTileAt(G.tiles, destRow, destCol);
	const hasCapitalOrCity =
		G.pieces.some((p: BoardPiece) => p.type === 'capital' && p.row === destRow && p.col === destCol) ||
		G.cities.some((c) => c.row === destRow && c.col === destCol);
	const canFound = !!tile && !hasCapitalOrCity && player.cubes >= 1;

	return { workerId: worker.id, row: destRow, col: destCol, foundCity: canFound };
}

export function useBotPlayers(matchID: Ref<string>, humanPlayerID: Ref<string>) {
	const bots: BotClient[] = [];
	let started = false;

	function startBots() {
		if (started) return;
		started = true;

		const creds = loadBotCredentials(matchID.value);
		const botPlayerIDs = Object.keys(creds).filter((id) => id !== humanPlayerID.value);

		for (const pid of botPlayerIDs) {
			const client = Client({
				game: gameDef.game,
				debug: false,
				multiplayer: SocketIO({ server: SERVER_URL }),
				matchID: matchID.value,
				playerID: pid,
				credentials: creds[pid],
			} as Parameters<typeof Client>[0]);

			let acting = false;

			const unsubscribe = client.subscribe((state: any) => {
				if (!state || acting) return;
				if (state.ctx.currentPlayer !== pid) return;
				if (state.ctx.gameover) return;

				const G = state.G as GoldenAgesState;
				const player = G.players[pid];
				if (!player) return;

				acting = true;

				setTimeout(() => {
					try {
						if (G.phase === 'eraStart') {
							client.moves.chooseCivCard(false);
						} else if (G.phase === 'tilePlacement') {
							const placement = findRandomValidPlacement(G, G.currentEra);
							if (placement) {
								client.moves.placeTile(placement.row, placement.col, placement.rotation, false);
							}
						} else if (G.phase === 'actions') {
							if (player.passedThisEra) {
								client.moves.collectGoldenAgeIncome();
							} else {
								const explorerMove = pickExplorerMove(G, pid);
								if (explorerMove) {
									client.moves.performAction(
										'explorer',
										explorerMove.workerId,
										explorerMove.row,
										explorerMove.col,
										explorerMove.foundCity,
									);
								} else {
									const isFirst = !Object.values(G.players).some((p) => p.passedThisEra);
									if (isFirst && G.historyJudgementCards.length > 0) {
										const card = G.historyJudgementCards[0];
										client.moves.performAction('startGoldenAge', card.id);
									} else {
										client.moves.performAction('startGoldenAge');
									}
								}
							}
						}
					} finally {
						acting = false;
					}
				}, 500);
			});

			client.start();
			bots.push({ playerID: pid, client, unsubscribe });
		}
	}

	watch(matchID, () => {
		if (matchID.value) startBots();
	}, { immediate: true });

	onUnmounted(() => {
		for (const bot of bots) {
			bot.unsubscribe();
			bot.client.stop();
		}
		bots.length = 0;
		started = false;
	});
}
