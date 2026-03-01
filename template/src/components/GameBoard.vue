<script setup lang="ts">
import { computed } from "vue";
import { useGame } from "@engine/client";
import type { TemplateGameState } from "../logic/game-logic";

defineProps<{ headerHeight: number }>();
defineEmits<{ "back-to-lobby": [] }>();

const { state, move, isMyTurn } = useGame();
const cells = computed(() => (state.value as unknown as TemplateGameState)?.cells ?? Array(9).fill(null));

function cellDisplay(val: string | null): string {
	if (val === "X") return "X";
	if (val === "O") return "O";
	return "";
}
</script>

<template>
	<div class="w-full max-w-lg mx-auto space-y-6">
		<p class="text-center text-slate-400 text-sm">Your game board — replace this component with your game UI.</p>
		<div
			class="grid grid-cols-3 gap-2 w-fit mx-auto"
			style="grid-template-columns: repeat(3, 64px); grid-template-rows: repeat(3, 64px);"
		>
			<button
				v-for="(cell, i) in cells"
				:key="i"
				type="button"
				class="flex items-center justify-center text-2xl font-bold bg-slate-800 border border-slate-600 rounded-lg hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				:disabled="!isMyTurn || cell !== null"
				@click="move('clickCell', i)"
			>
				{{ cellDisplay(cell) }}
			</button>
		</div>
	</div>
</template>
