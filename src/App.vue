<script setup lang="ts">
import { NobleProvider } from "@noble/bg-engine/client";
</script>

<template>
	<NobleProvider server-url="http://localhost:8000" :debug="true">
		<router-view />
	</NobleProvider>
</template>
