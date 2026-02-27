<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useGame, loadSession, clearSession } from "@noble/bg-engine/client";
import { gameDef, type GoldenAgesState, type GamePhase } from "../logic/game-logic";
import { useBotPlayers } from "../composables/useBotPlayers";
import GameBoard from "../components/GameBoard.vue";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8000";

const props = defineProps<{ matchID: string; playerID: string }>();
const router = useRouter();

const { isConnected, isMyTurn, state, gameover, reconnecting, connect, disconnect } = useGame();

const G = computed(() => state.value as unknown as GoldenAgesState | undefined);
const currentEra = computed(() => G.value?.currentEra ?? "I");
const currentPhase = computed<GamePhase>(() => G.value?.phase ?? "eraStart");

const PHASE_LABELS: Record<GamePhase, string> = {
	eraStart: "Era Start",
	tilePlacement: "Tile Placement",
	actions: "Actions",
};

const PLAYER_COLOR_TEXT: Record<string, string> = {
	red: "text-red-400",
	blue: "text-blue-400",
	green: "text-green-400",
	yellow: "text-yellow-400",
};

const currentPlayerColor = computed(() => {
	if (!G.value?.players) return null;
	const cp = (state.value as unknown as { ctx?: { currentPlayer?: string } })?.ctx?.currentPlayer;
	if (!cp) return null;
	return G.value.players[cp]?.color ?? null;
});

const confirmingAbandon = ref(false);

const matchIDRef = computed(() => props.matchID);
const playerIDRef = computed(() => props.playerID);
useBotPlayers(matchIDRef, playerIDRef);

onMounted(() => {
	const session = loadSession(gameDef.id, props.matchID);
	const creds = session?.playerID === props.playerID ? session.credentials : undefined;
	connect(gameDef.id, props.matchID, props.playerID, creds);
});

onUnmounted(() => disconnect());

async function abandonGame() {
	const session = loadSession(gameDef.id, props.matchID);
	if (!session) return;

	try {
		await fetch(`${SERVER_URL}/games/${gameDef.id}/${props.matchID}/leave`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				playerID: session.playerID,
				credentials: session.credentials,
			}),
		});
	} catch {
		// Clean up locally even if the server call fails
	}

	disconnect();
	clearSession(gameDef.id, props.matchID);
	router.push("/");
}
</script>

<template>
	<div class="min-h-screen bg-slate-900 text-white flex flex-col items-center">
		<!-- Pinned top bar -->
		<div class="fixed top-0 left-0 right-0 z-40 bg-slate-900 border-b border-slate-700/60">
			<div class="max-w-5xl mx-auto flex flex-wrap md:flex-nowrap items-center justify-between px-3 md:px-6 py-1.5 md:py-2 gap-x-3 gap-y-0.5">
				<router-link to="/" class="text-xs md:text-sm text-slate-500 hover:text-slate-300 transition-colors shrink-0"> &larr; Back </router-link>

				<div class="flex flex-col items-center order-first md:order-none w-full md:w-auto">
					<h1 class="text-sm md:text-lg font-semibold text-white leading-tight my-1 md:my-2">{{ gameDef.displayName }}</h1>
					<div v-if="G" class="flex items-center gap-2 md:gap-3 text-[10px] md:text-xs text-slate-400 mb-0.5 md:mb-1">
						<span
							>Era <strong class="text-white">{{ currentEra }}</strong></span
						>
						<span class="text-slate-600">·</span>
						<span>{{ PHASE_LABELS[currentPhase] }}</span>
						<template v-if="isMyTurn">
							<span class="text-slate-600">·</span>
							<span class="text-emerald-400 font-medium">Your turn</span>
						</template>
						<template v-else-if="currentPlayerColor">
							<span class="text-slate-600">·</span>
							<span
								>Waiting for
								<span class="font-medium capitalize" :class="PLAYER_COLOR_TEXT[currentPlayerColor]">{{
									currentPlayerColor
								}}</span></span
							>
						</template>
					</div>
				</div>

				<div class="flex items-center gap-2 md:gap-3 shrink-0">
					<span
						class="px-2 md:px-2.5 py-0.5 md:py-1 rounded-full text-[10px] md:text-xs"
						:class="isConnected ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'"
						>{{ isConnected ? "Connected" : "Connecting..." }}</span
					>

					<button class="text-[10px] md:text-xs text-red-500/60 hover:text-red-400 transition-colors" @click="confirmingAbandon = true">Abandon</button>
				</div>
			</div>
		</div>

		<!-- Spacer for pinned header -->
		<div class="h-14 md:h-16" />

		<div class="w-full flex flex-col items-center p-2 md:p-6">
			<!-- Game over banner -->
			<div v-if="gameover" class="mb-6 text-center">
				<p v-if="gameover.winner === playerID" class="text-2xl font-bold text-green-400">You win!</p>
				<p v-else-if="gameover.winner !== undefined" class="text-2xl font-bold text-red-400">You lose.</p>
				<p v-else class="text-2xl font-bold text-slate-400">It's a draw.</p>
			</div>

			<!-- Reconnecting overlay -->
			<div v-if="reconnecting" class="text-center">
				<p class="text-slate-400">Reconnecting...</p>
			</div>

			<!-- Game board -->
			<GameBoard v-if="!reconnecting" />
		</div>

		<!-- Abandon confirmation modal -->
		<Teleport to="body">
			<div
				v-if="confirmingAbandon"
				class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
				@click.self="confirmingAbandon = false"
			>
				<div class="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl">
					<h3 class="text-lg font-semibold text-white mb-2">Abandon game?</h3>
					<p class="text-sm text-slate-400 mb-6">This will remove you from the game. This action cannot be undone.</p>
					<div class="flex justify-end gap-3">
						<button
							class="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 transition-colors"
							@click="confirmingAbandon = false"
						>
							Cancel
						</button>
						<button
							class="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-500 transition-colors"
							@click="abandonGame"
						>
							Abandon
						</button>
					</div>
				</div>
			</div>
		</Teleport>
	</div>
</template>
