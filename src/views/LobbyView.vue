<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { saveSession, loadSession, clearSession } from "@noble/bg-engine/client";
import { gameDef } from "../logic/game-logic";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8000";
const POLL_INTERVAL = 3000;

const router = useRouter();

// ---------------------------------------------------------------------------
// Player identity
// ---------------------------------------------------------------------------

const playerName = ref(localStorage.getItem("bgf:playerName") ?? "");

function persistName(): string {
	const name = playerName.value.trim() || "Player";
	localStorage.setItem("bgf:playerName", name);
	return name;
}

// ---------------------------------------------------------------------------
// Match types
// ---------------------------------------------------------------------------

interface MatchPlayer {
	id: number;
	name?: string;
}

interface MatchInfo {
	matchID: string;
	players: MatchPlayer[];
	gameover: unknown;
	createdAt: number;
	updatedAt: number;
}

interface MyGameInfo extends MatchInfo {
	myPlayerID: string;
	myName: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type ViewMode = "browse" | "hosting";
const viewMode = ref<ViewMode>("browse");

const myGames = ref<MyGameInfo[]>([]);
const openGames = ref<MatchInfo[]>([]);
const loading = ref(true);
const errorMsg = ref("");

const showCreateForm = ref(false);
const numPlayers = ref(gameDef.minPlayers);
const creating = ref(false);

const hostedMatchID = ref<string | null>(null);
const hostedPlayers = ref<MatchPlayer[]>([]);
const linkCopied = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchMatchList(): Promise<MatchInfo[]> {
	const res = await fetch(`${SERVER_URL}/games/${gameDef.id}`);
	if (!res.ok) return [];
	const data = await res.json();
	return (data.matches ?? []) as MatchInfo[];
}

async function fetchMatch(matchID: string): Promise<MatchInfo | null> {
	const res = await fetch(`${SERVER_URL}/games/${gameDef.id}/${matchID}`);
	if (!res.ok) return null;
	const data = (await res.json()) as MatchInfo;
	data.matchID = matchID;
	return data;
}

function getStoredSessions(): { matchID: string; playerID: string; playerName: string }[] {
	const sessions: { matchID: string; playerID: string; playerName: string }[] = [];
	const prefix = `bgf:session:${gameDef.id}:`;
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (key?.startsWith(prefix)) {
			const matchID = key.slice(prefix.length);
			const session = loadSession(gameDef.id, matchID);
			if (session) {
				sessions.push({
					matchID,
					playerID: session.playerID,
					playerName: session.playerName,
				});
			}
		}
	}
	return sessions;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function refreshData() {
	try {
		const allMatches = await fetchMatchList();
		const sessions = getStoredSessions();

		const myMatchIDs = new Set(sessions.map((s) => s.matchID));

		const myGamesList: MyGameInfo[] = [];
		for (const session of sessions) {
			const match = allMatches.find((m) => m.matchID === session.matchID);
			if (match) {
				myGamesList.push({
					...match,
					myPlayerID: session.playerID,
					myName: session.playerName,
				});
			}
		}
		myGames.value = myGamesList.sort((a, b) => b.updatedAt - a.updatedAt);

		openGames.value = allMatches
			.filter((m) => {
				if (myMatchIDs.has(m.matchID)) return false;
				if (m.gameover) return false;
				return m.players.some((p) => !p.name);
			})
			.sort((a, b) => b.createdAt - a.createdAt);
	} catch {
		errorMsg.value = "Could not connect to game server";
	} finally {
		loading.value = false;
	}
}

// ---------------------------------------------------------------------------
// Game creation
// ---------------------------------------------------------------------------

async function createMatch() {
	if (!playerName.value.trim()) return;
	creating.value = true;
	errorMsg.value = "";

	try {
		const name = persistName();

		const createRes = await fetch(`${SERVER_URL}/games/${gameDef.id}/create`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ numPlayers: numPlayers.value }),
		});
		if (!createRes.ok) throw new Error("Server rejected match creation");
		const { matchID } = (await createRes.json()) as { matchID: string };

		const joinRes = await fetch(`${SERVER_URL}/games/${gameDef.id}/${matchID}/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ playerID: "0", playerName: name }),
		});
		if (!joinRes.ok) throw new Error("Failed to claim host seat");
		const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

		saveSession(gameDef.id, matchID, {
			playerID: "0",
			credentials: playerCredentials,
			playerName: name,
		});

		hostedMatchID.value = matchID;
		showCreateForm.value = false;
		viewMode.value = "hosting";
		startHostPolling(matchID);
	} catch (e: unknown) {
		errorMsg.value = e instanceof Error ? e.message : "Failed to create match";
	} finally {
		creating.value = false;
	}
}

// ---------------------------------------------------------------------------
// Join an open game
// ---------------------------------------------------------------------------

async function joinGame(matchID: string) {
	if (!playerName.value.trim()) {
		errorMsg.value = "Please enter your name first";
		return;
	}
	errorMsg.value = "";

	try {
		const name = persistName();

		const match = await fetchMatch(matchID);
		if (!match) throw new Error("Match not found");

		const openSeat = match.players.find((p) => !p.name);
		if (!openSeat) throw new Error("No open seats");
		const seatID = String(openSeat.id);

		const joinRes = await fetch(`${SERVER_URL}/games/${gameDef.id}/${matchID}/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ playerID: seatID, playerName: name }),
		});
		if (!joinRes.ok) throw new Error("Failed to claim seat");
		const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

		saveSession(gameDef.id, matchID, {
			playerID: seatID,
			credentials: playerCredentials,
			playerName: name,
		});

		router.push(`/game/${matchID}/${seatID}`);
	} catch (e: unknown) {
		errorMsg.value = e instanceof Error ? e.message : "Failed to join game";
	}
}

// ---------------------------------------------------------------------------
// Abandon a game (only when not all seats are filled)
// ---------------------------------------------------------------------------

async function abandonGame(matchID: string) {
	errorMsg.value = "";
	const session = loadSession(gameDef.id, matchID);
	if (!session) return;

	try {
		const res = await fetch(`${SERVER_URL}/games/${gameDef.id}/${matchID}/leave`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				playerID: session.playerID,
				credentials: session.credentials,
			}),
		});
		if (!res.ok) throw new Error("Server rejected leave request");

		const botCredsKey = `bgf:bots:${gameDef.id}:${matchID}`;
		const botCreds = JSON.parse(localStorage.getItem(botCredsKey) || "{}");
		const botPlayerIDs = Object.keys(botCreds);
		if (botPlayerIDs.length > 0) {
			for (const botPid of botPlayerIDs) {
				try {
					await fetch(`${SERVER_URL}/games/${gameDef.id}/${matchID}/leave`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ playerID: botPid, credentials: botCreds[botPid] }),
					});
				} catch { /* best effort */ }
			}
			localStorage.removeItem(botCredsKey);
		}
	} catch {
		// Even if the server call fails, clean up locally
	}

	clearSession(gameDef.id, matchID);
	await refreshData();
}

async function abandonHostedGame() {
	if (!hostedMatchID.value) return;
	await abandonGame(hostedMatchID.value);
	backToBrowse();
}

// ---------------------------------------------------------------------------
// Hosting / waiting room
// ---------------------------------------------------------------------------

function startHostPolling(matchID: string) {
	stopPolling();
	pollHostedMatch(matchID);
	pollTimer = setInterval(() => pollHostedMatch(matchID), 2000);
}

async function pollHostedMatch(matchID: string) {
	const match = await fetchMatch(matchID);
	if (!match) return;
	hostedPlayers.value = match.players;
}

const allSeatsFilled = computed(() => hostedPlayers.value.length > 0 && hostedPlayers.value.every((p) => p.name));

const filledCount = computed(() => hostedPlayers.value.filter((p) => p.name).length);

const fillingBots = ref(false);

function saveBotCredentials(mID: string, playerID: string, credentials: string) {
	const key = `bgf:bots:${gameDef.id}:${mID}`;
	const existing = JSON.parse(localStorage.getItem(key) || "{}");
	existing[playerID] = credentials;
	localStorage.setItem(key, JSON.stringify(existing));
}

async function fillWithBots() {
	if (!hostedMatchID.value) return;
	fillingBots.value = true;
	errorMsg.value = "";

	try {
		const emptySeats = hostedPlayers.value.filter((p) => !p.name);
		for (let i = 0; i < emptySeats.length; i++) {
			const seatID = String(emptySeats[i].id);
			const botName = `Bot ${emptySeats[i].id}`;
			const res = await fetch(`${SERVER_URL}/games/${gameDef.id}/${hostedMatchID.value}/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ playerID: seatID, playerName: botName }),
			});
			if (!res.ok) throw new Error(`Failed to seat ${botName}`);
			const { playerCredentials } = (await res.json()) as { playerCredentials: string };
			saveBotCredentials(hostedMatchID.value, seatID, playerCredentials);
		}
		await pollHostedMatch(hostedMatchID.value);
	} catch (e: unknown) {
		errorMsg.value = e instanceof Error ? e.message : "Failed to fill bots";
	} finally {
		fillingBots.value = false;
	}
}

async function fillBotsForGame(matchID: string) {
	errorMsg.value = "";
	try {
		const match = await fetchMatch(matchID);
		if (!match) throw new Error("Match not found");

		const emptySeats = match.players.filter((p) => !p.name);
		for (const seat of emptySeats) {
			const seatID = String(seat.id);
			const res = await fetch(`${SERVER_URL}/games/${gameDef.id}/${matchID}/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ playerID: seatID, playerName: `Bot ${seatID}` }),
			});
			if (!res.ok) throw new Error(`Failed to seat Bot ${seatID}`);
			const { playerCredentials } = (await res.json()) as { playerCredentials: string };
			saveBotCredentials(matchID, seatID, playerCredentials);
		}
		await refreshData();
	} catch (e: unknown) {
		errorMsg.value = e instanceof Error ? e.message : "Failed to add bots";
	}
}

function inviteLink(): string {
	if (!hostedMatchID.value) return "";
	return `${window.location.origin}/join/${hostedMatchID.value}`;
}

async function copyLink() {
	try {
		await navigator.clipboard.writeText(inviteLink());
		linkCopied.value = true;
		setTimeout(() => {
			linkCopied.value = false;
		}, 2000);
	} catch {
		errorMsg.value = "Clipboard access denied";
	}
}

function startGame() {
	if (!hostedMatchID.value) return;
	stopPolling();
	router.push(`/game/${hostedMatchID.value}/0`);
}

function backToBrowse() {
	stopPolling();
	viewMode.value = "browse";
	hostedMatchID.value = null;
	hostedPlayers.value = [];
	refreshData();
}

// ---------------------------------------------------------------------------
// Computed helpers
// ---------------------------------------------------------------------------

function seatSummary(players: MatchPlayer[]): string {
	const filled = players.filter((p) => p.name).length;
	return `${filled}/${players.length}`;
}

function matchStatus(match: MatchInfo): "waiting" | "playing" | "finished" {
	if (match.gameover) return "finished";
	if (match.players.every((p) => p.name)) return "playing";
	return "waiting";
}

// ---------------------------------------------------------------------------
// Polling & lifecycle
// ---------------------------------------------------------------------------

function stopPolling() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

function startBrowsePolling() {
	stopPolling();
	pollTimer = setInterval(refreshData, POLL_INTERVAL);
}

onMounted(() => {
	refreshData();
	startBrowsePolling();
});

onUnmounted(stopPolling);
</script>

<template>
	<div class="min-h-screen bg-slate-900 text-white">
		<!-- Header -->
		<header class="border-b border-slate-800">
			<div class="max-w-5xl mx-auto px-6 py-8">
				<h1 class="text-4xl font-bold tracking-tight">{{ gameDef.displayName }}</h1>
				<p class="mt-2 text-slate-400">{{ gameDef.description }}</p>

				<!-- Player name (always visible) -->
				<div class="mt-6 flex items-center gap-3 max-w-sm">
					<label class="text-sm font-medium text-slate-400 shrink-0">Your Name</label>
					<input
						v-model="playerName"
						placeholder="Enter your name"
						maxlength="24"
						class="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
						@change="persistName"
					/>
				</div>
			</div>
		</header>

		<!-- Main content -->
		<main class="max-w-5xl mx-auto px-6 py-8">
			<!-- Error banner -->
			<div
				v-if="errorMsg"
				class="mb-6 p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-400 flex items-center justify-between"
			>
				<span>{{ errorMsg }}</span>
				<button class="text-red-400 hover:text-red-300 ml-4" @click="errorMsg = ''">Dismiss</button>
			</div>

			<!-- Loading -->
			<div v-if="loading" class="text-center py-16">
				<p class="text-slate-400">Connecting to server...</p>
			</div>

			<!-- BROWSE MODE -->
			<template v-else-if="viewMode === 'browse'">
				<!-- Create game button -->
				<div class="mb-8">
					<button
						v-if="!showCreateForm"
						class="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg font-semibold transition-colors disabled:opacity-50"
						:disabled="!playerName.trim()"
						@click="showCreateForm = true"
					>
						Create New Game
					</button>

					<!-- Create form (inline) -->
					<div v-else class="p-5 bg-slate-800 border border-slate-700 rounded-xl max-w-md space-y-4">
						<h3 class="font-semibold">New Game</h3>

						<div class="space-y-2">
							<label class="block text-sm text-slate-400">Number of Players</label>
							<div class="flex items-center gap-3">
								<button
									class="w-9 h-9 rounded-lg bg-slate-700 border border-slate-600 text-lg font-bold hover:bg-slate-600 transition-colors disabled:opacity-40"
									:disabled="numPlayers <= gameDef.minPlayers"
									@click="numPlayers--"
								>
									-
								</button>
								<span class="text-xl font-bold w-6 text-center">{{ numPlayers }}</span>
								<button
									class="w-9 h-9 rounded-lg bg-slate-700 border border-slate-600 text-lg font-bold hover:bg-slate-600 transition-colors disabled:opacity-40"
									:disabled="numPlayers >= gameDef.maxPlayers"
									@click="numPlayers++"
								>
									+
								</button>
								<span class="text-sm text-slate-500 ml-1">({{ gameDef.minPlayers }}&ndash;{{ gameDef.maxPlayers }})</span>
							</div>
						</div>

						<div class="flex gap-2">
							<button
								class="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50"
								:disabled="creating"
								@click="createMatch"
							>
								{{ creating ? "Creating..." : "Create" }}
							</button>
							<button
								class="px-5 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition-colors"
								@click="showCreateForm = false"
							>
								Cancel
							</button>
						</div>
					</div>
				</div>

				<!-- Two-column layout -->
				<div class="grid md:grid-cols-2 gap-8">
					<!-- Your Games -->
					<section>
						<h2 class="text-lg font-semibold mb-4 text-slate-300">Your Games</h2>

						<div v-if="myGames.length === 0" class="p-6 bg-slate-800/50 border border-slate-700/50 rounded-xl text-center">
							<p class="text-slate-500 text-sm">No active games yet. Create or join one!</p>
						</div>

						<div v-else class="space-y-3">
							<div v-for="game in myGames" :key="game.matchID" class="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
								<div class="p-4">
									<div class="flex items-center gap-2 mb-1">
										<span
											class="inline-block w-2 h-2 rounded-full"
											:class="{
												'bg-yellow-400': matchStatus(game) === 'waiting',
												'bg-green-400': matchStatus(game) === 'playing',
												'bg-slate-500': matchStatus(game) === 'finished',
											}"
										/>
										<span class="text-sm font-medium capitalize">{{ matchStatus(game) }}</span>
										<span class="text-xs text-slate-500 ml-auto">{{ seatSummary(game.players) }} players</span>
									</div>
									<p class="text-xs text-slate-500 mt-1">
										{{
											game.players
												.filter((p) => p.name)
												.map((p) => p.name)
												.join(", ")
										}}
									</p>
								</div>
								<div class="flex border-t border-slate-700 divide-x divide-slate-700">
									<button
										class="flex-1 px-3 py-2 text-xs font-medium text-blue-400 hover:bg-slate-700/50 transition-colors"
										@click="router.push(`/game/${game.matchID}/${game.myPlayerID}`)"
									>
										Resume
									</button>
									<button
										v-if="matchStatus(game) === 'waiting' && game.myPlayerID === '0'"
										class="flex-1 px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-700/50 transition-colors"
										@click="fillBotsForGame(game.matchID)"
									>
										Add Bots
									</button>
									<button
										v-if="game.myPlayerID === '0'"
										class="flex-1 px-3 py-2 text-xs font-medium text-red-400/70 hover:bg-red-900/20 hover:text-red-400 transition-colors"
										@click="abandonGame(game.matchID)"
									>
										Abandon
									</button>
								</div>
							</div>
						</div>
					</section>

					<!-- Open Games -->
					<section>
						<h2 class="text-lg font-semibold mb-4 text-slate-300">Open Games</h2>

						<div v-if="openGames.length === 0" class="p-6 bg-slate-800/50 border border-slate-700/50 rounded-xl text-center">
							<p class="text-slate-500 text-sm">No open games right now.</p>
						</div>

						<div v-else class="space-y-3">
							<div v-for="game in openGames" :key="game.matchID" class="p-4 bg-slate-800 border border-slate-700 rounded-xl">
								<div class="flex items-center justify-between">
									<div>
										<p class="text-sm font-medium">{{ seatSummary(game.players) }} players</p>
										<p class="text-xs text-slate-500 mt-0.5">
											{{
												game.players
													.filter((p) => p.name)
													.map((p) => p.name)
													.join(", ") || "No players yet"
											}}
										</p>
									</div>
									<button
										class="px-4 py-2 bg-green-600 hover:bg-green-500 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
										:disabled="!playerName.trim()"
										@click="joinGame(game.matchID)"
									>
										Join
									</button>
								</div>
							</div>
						</div>
					</section>
				</div>
			</template>

			<!-- HOSTING MODE (waiting room) -->
			<template v-else-if="viewMode === 'hosting'">
				<button class="mb-6 text-sm text-slate-500 hover:text-slate-300 transition-colors" @click="backToBrowse">&larr; Back to lobby</button>

				<div class="max-w-md mx-auto space-y-6">
					<div class="p-5 bg-slate-800 border border-slate-700 rounded-xl space-y-4">
						<div class="flex items-center gap-2">
							<span class="inline-block w-2 h-2 rounded-full bg-green-400" />
							<h3 class="font-semibold">Game Created</h3>
						</div>

						<div class="space-y-1">
							<label class="block text-xs text-slate-500">Invite Link</label>
							<div class="flex gap-2">
								<code class="flex-1 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-blue-400 truncate">
									{{ inviteLink() }}
								</code>
								<button
									class="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition-colors shrink-0"
									@click="copyLink"
								>
									{{ linkCopied ? "Copied!" : "Copy" }}
								</button>
							</div>
						</div>
					</div>

					<div class="p-5 bg-slate-800 border border-slate-700 rounded-xl space-y-3">
						<div class="flex items-center justify-between">
							<span class="text-sm font-medium text-slate-400">Players</span>
							<span class="text-sm text-slate-500">{{ filledCount }} / {{ hostedPlayers.length }}</span>
						</div>
						<ul class="space-y-2">
							<li v-for="p in hostedPlayers" :key="p.id" class="flex items-center gap-3 px-3 py-2.5 bg-slate-900 rounded-lg">
								<span class="w-2 h-2 rounded-full shrink-0" :class="p.name ? 'bg-green-400' : 'bg-slate-600'" />
								<span class="text-sm" :class="p.name ? 'text-white' : 'text-slate-600'">
									{{ p.name || "Waiting..." }}
								</span>
								<span v-if="p.id === 0" class="ml-auto text-xs text-slate-500">Host</span>
							</li>
						</ul>
					</div>

					<button
						class="w-full py-3 bg-green-600 hover:bg-green-500 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						:disabled="!allSeatsFilled"
						@click="startGame"
					>
						{{ allSeatsFilled ? "Start Game" : `Waiting for players (${filledCount}/${hostedPlayers.length})...` }}
					</button>

					<div v-if="!allSeatsFilled" class="flex gap-2">
						<button
							class="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm text-slate-400 hover:text-white font-medium transition-colors disabled:opacity-50"
							:disabled="fillingBots"
							@click="fillWithBots"
						>
							{{ fillingBots ? "Adding..." : "Fill with Bots" }}
						</button>
						<button
							class="flex-1 py-2.5 bg-slate-800 hover:bg-red-900/40 border border-slate-700 hover:border-red-800 rounded-lg text-sm text-slate-400 hover:text-red-400 font-medium transition-colors"
							@click="abandonHostedGame"
						>
							Abandon Game
						</button>
					</div>
				</div>
			</template>
		</main>
	</div>
</template>
