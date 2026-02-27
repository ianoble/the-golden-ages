<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useGame, loadSession, clearSession } from "@noble/bg-engine/client";
import { gameDef, type GoldenAgesState, type GamePhase } from "../logic/game-logic";
import { useBotPlayers } from "../composables/useBotPlayers";
import GameBoard from "../components/GameBoard.vue";
import { SERVER_URL } from "../config";
import {
	deleteServerSession,
	voteToAbandon,
	cancelAbandonVote,
	getAbandonVoteStatus,
	type AbandonVoteStatus,
} from "../composables/useAuth";

const props = defineProps<{ matchID: string; playerID: string }>();
const router = useRouter();

const { isConnected, isMyTurn, state, currentPlayer, gameover, reconnecting, connect, disconnect } = useGame();

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
	const cp = currentPlayer.value;
	if (!cp) return null;
	return G.value.players[cp]?.color ?? null;
});

const confirmingAbandon = ref(false);
const gameMenuOpen = ref(false);

function closeGameMenu() {
	gameMenuOpen.value = false;
}

function onClickOutsideMenu(e: MouseEvent) {
	const target = e.target as HTMLElement;
	if (!target.closest('.game-menu-container')) {
		closeGameMenu();
	}
}
const abandonVoteStatus = ref<AbandonVoteStatus | null>(null);
const iHaveVoted = computed(() => {
	if (!abandonVoteStatus.value) return false;
	const myName = localStorage.getItem("bgf:playerName") ?? "";
	return abandonVoteStatus.value.voters.includes(myName);
});

const isMultiHuman = computed(() => {
	const botCredsKey = `bgf:bots:${gameDef.id}:${props.matchID}`;
	const botCreds = JSON.parse(localStorage.getItem(botCredsKey) || "{}");
	const numBots = Object.keys(botCreds).length;
	const totalPlayers = G.value ? Object.keys(G.value.players).length : 0;
	return totalPlayers - numBots >= 2;
});

let votePollTimer: ReturnType<typeof setInterval> | null = null;

function startVotePolling() {
	stopVotePolling();
	pollVoteStatus();
	votePollTimer = setInterval(pollVoteStatus, 3000);
}

function stopVotePolling() {
	if (votePollTimer) {
		clearInterval(votePollTimer);
		votePollTimer = null;
	}
}

async function pollVoteStatus() {
	const status = await getAbandonVoteStatus(gameDef.id, props.matchID);
	abandonVoteStatus.value = status;
	if (status?.allAgreed) {
		stopVotePolling();
		await abandonGame();
	}
}

const matchIDRef = computed(() => props.matchID);
const playerIDRef = computed(() => props.playerID);
useBotPlayers(matchIDRef, playerIDRef);

onMounted(() => {
	const session = loadSession(gameDef.id, props.matchID);
	const creds = session?.playerID === props.playerID ? session.credentials : undefined;
	connect(gameDef.id, props.matchID, props.playerID, creds);
	startVotePolling();
	document.addEventListener('click', onClickOutsideMenu);
});

onUnmounted(() => {
	disconnect();
	stopVotePolling();
	document.removeEventListener('click', onClickOutsideMenu);
});

async function handleAbandonClick() {
	if (!isMultiHuman.value) {
		confirmingAbandon.value = true;
		return;
	}
	const status = await voteToAbandon(gameDef.id, props.matchID);
	if (status) {
		abandonVoteStatus.value = status;
		if (status.allAgreed) {
			await abandonGame();
		}
	}
}

async function handleAgreeVote() {
	const status = await voteToAbandon(gameDef.id, props.matchID);
	if (status) {
		abandonVoteStatus.value = status;
		if (status.allAgreed) {
			await abandonGame();
		}
	}
}

async function handleCancelVote() {
	await cancelAbandonVote(gameDef.id, props.matchID);
	abandonVoteStatus.value = null;
}

async function abandonGame() {
	stopVotePolling();
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

		const botCredsKey = `bgf:bots:${gameDef.id}:${props.matchID}`;
		const botCreds = JSON.parse(localStorage.getItem(botCredsKey) || "{}");
		const botPlayerIDs = Object.keys(botCreds);
		if (botPlayerIDs.length > 0) {
			for (const botPid of botPlayerIDs) {
				try {
					await fetch(`${SERVER_URL}/games/${gameDef.id}/${props.matchID}/leave`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ playerID: botPid, credentials: botCreds[botPid] }),
					});
				} catch { /* best effort */ }
			}
			localStorage.removeItem(botCredsKey);
		}
	} catch {
		// Clean up locally even if the server call fails
	}

	disconnect();
	clearSession(gameDef.id, props.matchID);
	await deleteServerSession(gameDef.id, props.matchID);
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
					<div class="relative game-menu-container my-1 md:my-2">
						<button
							class="flex items-center gap-1 text-sm md:text-lg font-semibold text-white leading-tight hover:text-slate-300 transition-colors"
							@click.stop="gameMenuOpen = !gameMenuOpen"
						>
							{{ gameDef.displayName }}
							<svg class="w-3 h-3 md:w-4 md:h-4 text-slate-400 transition-transform" :class="gameMenuOpen ? 'rotate-180' : ''" viewBox="0 0 20 20" fill="currentColor">
								<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
							</svg>
						</button>
						<div
							v-if="gameMenuOpen"
							class="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1 min-w-[180px] z-50"
						>
							<a
								href="https://boardgamegeek.com/filepage/97498/golden-ages-rules"
								target="_blank"
								rel="noopener"
								class="flex items-center gap-2 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
								@click="closeGameMenu"
							>
								<svg class="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
								Rulebook
								<svg class="w-3 h-3 ml-auto text-slate-500" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5zm7.5-2.25a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0V5.56l-5.72 5.72a.75.75 0 11-1.06-1.06l5.72-5.72h-2.69a.75.75 0 01-.75-.75z" clip-rule="evenodd" /></svg>
							</a>
							<a
								href="https://boardgamegeek.com/filepage/97499/golden-ages-card-index"
								target="_blank"
								rel="noopener"
								class="flex items-center gap-2 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
								@click="closeGameMenu"
							>
								<svg class="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
								Card Index
								<svg class="w-3 h-3 ml-auto text-slate-500" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5zm7.5-2.25a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0V5.56l-5.72 5.72a.75.75 0 11-1.06-1.06l5.72-5.72h-2.69a.75.75 0 01-.75-.75z" clip-rule="evenodd" /></svg>
							</a>
						</div>
					</div>
					<div v-if="G" class="flex items-center gap-2 md:gap-3 text-[10px] md:text-xs text-slate-400 mb-0.5 md:mb-1 min-h-5 md:min-h-6">
						<span
							>Era <strong class="text-white">{{ currentEra }}</strong></span
						>
						<span class="text-slate-600">·</span>
						<span>{{ PHASE_LABELS[currentPhase] }}</span>
						<template v-if="isMyTurn">
							<span class="text-slate-600">·</span>
							<span class="text-emerald-400 font-medium animate-pulse">Your turn</span>
						</template>
						<template v-else-if="currentPlayerColor">
							<span class="text-slate-600">·</span>
							<span
								class="px-1.5 py-0.5 rounded text-[10px] md:text-xs font-medium leading-none"
								:class="{
									'bg-red-900/40 text-red-300': currentPlayerColor === 'red',
									'bg-blue-900/40 text-blue-300': currentPlayerColor === 'blue',
									'bg-green-900/40 text-green-300': currentPlayerColor === 'green',
									'bg-yellow-900/40 text-yellow-300': currentPlayerColor === 'yellow',
								}"
							>
								<span class="capitalize">{{ currentPlayerColor }}</span>'s turn
							</span>
						</template>
					</div>
				</div>

				<div class="flex items-center gap-2 md:gap-3 shrink-0">
					<span
						class="px-2 md:px-2.5 py-0.5 md:py-1 rounded-full text-[10px] md:text-xs"
						:class="isConnected ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'"
						>{{ isConnected ? "Connected" : "Connecting..." }}</span
					>

					<button class="text-[10px] md:text-xs text-red-500/60 hover:text-red-400 transition-colors" @click="handleAbandonClick">Abandon</button>
				</div>
			</div>
		</div>

		<!-- Spacer for pinned header -->
		<div class="h-24 md:h-20" />

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

		<!-- Abandon vote overlay (multi-human games) -->
		<Teleport to="body">
			<div
				v-if="abandonVoteStatus"
				class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			>
				<div class="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl">
					<h3 class="text-lg font-semibold text-white mb-1">Abandon Vote</h3>
					<p class="text-sm text-slate-400 mb-5">
						{{ abandonVoteStatus.voters.length }} of {{ abandonVoteStatus.totalHumans }} players want to abandon.
					</p>

					<ul class="space-y-2 mb-6">
						<li
							v-for="voter in abandonVoteStatus.voters"
							:key="voter"
							class="flex items-center gap-2 text-sm"
						>
							<span class="w-4 h-4 rounded bg-red-600/30 border border-red-500/50 flex items-center justify-center text-[10px] text-red-400">&#10003;</span>
							<span class="text-slate-300">{{ voter }}</span>
						</li>
					</ul>

					<div class="flex gap-3">
						<template v-if="iHaveVoted">
							<button
								class="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 transition-colors"
								@click="handleCancelVote"
							>
								Cancel My Vote
							</button>
						</template>
						<template v-else>
							<button
								class="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-500 transition-colors"
								@click="handleAgreeVote"
							>
								Agree to Abandon
							</button>
						</template>
					</div>
				</div>
			</div>
		</Teleport>

		<!-- Abandon confirmation modal (solo human + bots only) -->
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
