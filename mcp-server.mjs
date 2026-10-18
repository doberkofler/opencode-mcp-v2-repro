#!/usr/bin/env node
/**
 * Dependency-free stdio MCP server exposing one trivial tool: `example_ping`.
 *
 * Kept intentionally minimal so the reproduction cannot fail because of an MCP
 * SDK version, transport, or tool-schema problem. Diagnostics go to stderr
 * because stdout belongs to the MCP transport.
 */

import {writeFileSync} from 'node:fs';

const SERVER_INFO = {name: 'repro-ping-server', version: '1.0.0'};

const TOOL = {
	name: 'example_ping',
	description: 'Returns the string "pong". Call this tool when asked to ping.',
	inputSchema: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
};

const send = (message) => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};

const reply = (id, result) => {
	send({jsonrpc: '2.0', id, result});
};

const fail = (id, code, message) => {
	send({jsonrpc: '2.0', id, error: {code, message}});
};

const handle = (message) => {
	if (message.method === undefined) {
		return;
	}

	if (message.id === undefined) {
		// Notification (for example notifications/initialized): no response.
		return;
	}

	const {id, method, params} = message;

	switch (method) {
		case 'initialize': {
			reply(id, {
				protocolVersion: params?.protocolVersion ?? '2025-06-18',
				capabilities: {tools: {}},
				serverInfo: SERVER_INFO,
			});

			return;
		}
		case 'ping': {
			reply(id, {});

			return;
		}
		case 'tools/list': {
			const markerPath = process.env.REPRO_HANDSHAKE_FILE;

			if (markerPath) {
				writeFileSync(markerPath, JSON.stringify({tools: [TOOL.name]}));
			}

			reply(id, {tools: [TOOL]});

			return;
		}
		case 'tools/call': {
			if (params?.name !== TOOL.name) {
				fail(id, -32602, `Unknown tool: ${String(params?.name)}`);

				return;
			}

			reply(id, {content: [{type: 'text', text: 'pong'}], isError: false});

			return;
		}
		case 'resources/list': {
			reply(id, {resources: []});

			return;
		}
		case 'resources/templates/list': {
			reply(id, {resourceTemplates: []});

			return;
		}
		case 'prompts/list': {
			reply(id, {prompts: []});

			return;
		}
		default: {
			fail(id, -32601, `Method not found: ${method}`);
		}
	}
};

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buffer += chunk;

	let newlineIndex = buffer.indexOf('\n');
	while (newlineIndex !== -1) {
		const line = buffer.slice(0, newlineIndex).trim();
		buffer = buffer.slice(newlineIndex + 1);

		if (line !== '') {
			try {
				handle(JSON.parse(line));
			} catch (error) {
				process.stderr.write(`invalid MCP payload: ${String(error)}\n`);
			}
		}

		newlineIndex = buffer.indexOf('\n');
	}
});

process.stderr.write('repro-ping-server started\n');
