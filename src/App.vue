<script setup lang="ts">
import { NobleProvider } from "@noble/bg-engine/client";

const serverUrl = import.meta.env.VITE_SERVER_URL || "http://localhost:8000";
</script>

<template>
	<NobleProvider :server-url="serverUrl" :debug="true">
		<router-view />
	</NobleProvider>
</template>
