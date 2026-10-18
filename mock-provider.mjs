#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible provider used to observe the exact tool set OpenCode
 * sends to a model.
 *
 * Every chat-completion request is appended to `requests.jsonl`. If the request
 * advertises a tool whose name contains "ping", the mock calls it; otherwise it
 * answers with NO_PING_TOOL. That makes the defect visible both in the captured
 * request and in the assistant's final message.
 */

import {appendFileSync} from 'node:fs';
import {createServer} from 'node:http';

const PORT = Number(process.env.MOCK_PROVIDER_PORT ?? 0);
const LOG_PATH = process.env.MOCK_PROVIDER_LOG;
const BODY_LOG_PATH = process.env.MOCK_PROVIDER_BODY_LOG;
const MCP_SERVER_NAME = process.env.MOCK_MCP_SERVER_NAME ?? 'reproping';
const MODEL = 'repro-probe';

if (!LOG_PATH) {
	throw new Error('MOCK_PROVIDER_LOG is required');
}

const findPingTool = (tools) => {
	for (const tool of tools ?? []) {
		if (typeof tool?.function?.name === 'string' && tool.function.name.includes('ping')) {
			return tool.function.name;
		}
	}

	return undefined;
};

const hasToolResult = (messages) => {
	for (const message of messages ?? []) {
		if (message?.role === 'tool') {
			return true;
		}
	}

	return false;
};

const chunk = (delta, finishReason = null) => ({
	id: 'chatcmpl-repro',
	object: 'chat.completion.chunk',
	created: Math.floor(Date.now() / 1000),
	model: MODEL,
	choices: [{index: 0, delta, finish_reason: finishReason}],
});

const writeSse = (response, payload) => {
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const respond = (response, body) => {
	const tools = body.tools ?? [];
	const toolNames = tools.map((tool) => tool?.function?.name ?? null);
	const pingTool = findPingTool(tools);

	const record = {
		capturedAt: new Date().toISOString(),
		model: body.model ?? null,
		stream: body.stream ?? null,
		toolNames,
		pingToolPresent: pingTool !== undefined,
		executeToolPresent: toolNames.includes('execute'),
		mcpServerMentionedInMessages: JSON.stringify(body.messages ?? []).includes(MCP_SERVER_NAME),
		messageRoles: (body.messages ?? []).map((message) => message?.role ?? null),
	};
	appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`);

	if (BODY_LOG_PATH) {
		appendFileSync(BODY_LOG_PATH, `${JSON.stringify(body)}\n`);
	}

	const wantsToolCall = pingTool !== undefined && !hasToolResult(body.messages);

	if (body.stream === false) {
		const message = wantsToolCall
			? {
					role: 'assistant',
					content: null,
					tool_calls: [
						{
							id: 'call_repro_1',
							type: 'function',
							function: {name: pingTool, arguments: '{}'},
						},
					],
				}
			: {
					role: 'assistant',
					content: pingTool === undefined ? 'NO_PING_TOOL' : 'pong received',
				};

		response.writeHead(200, {'content-type': 'application/json'});
		response.end(
			JSON.stringify({
				id: 'chatcmpl-repro',
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: MODEL,
				choices: [
					{
						index: 0,
						message,
						finish_reason: wantsToolCall ? 'tool_calls' : 'stop',
					},
				],
				usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
			}),
		);

		return;
	}

	response.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache',
		connection: 'keep-alive',
	});

	writeSse(response, chunk({role: 'assistant', content: ''}));

	if (wantsToolCall) {
		writeSse(
			response,
			chunk({
				tool_calls: [
					{
						index: 0,
						id: 'call_repro_1',
						type: 'function',
						function: {name: pingTool, arguments: '{}'},
					},
				],
			}),
		);
		writeSse(response, chunk({}, 'tool_calls'));
	} else {
		writeSse(
			response,
			chunk({content: pingTool === undefined ? 'NO_PING_TOOL' : 'pong received'}),
		);
		writeSse(response, chunk({}, 'stop'));
	}

	response.write('data: [DONE]\n\n');
	response.end();
};

const server = createServer((request, response) => {
	const chunks = [];

	request.on('data', (data) => {
		chunks.push(data);
	});

	request.on('end', () => {
		const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

		if (request.method === 'GET' && url.pathname.endsWith('/models')) {
			response.writeHead(200, {'content-type': 'application/json'});
			response.end(
				JSON.stringify({object: 'list', data: [{id: MODEL, object: 'model'}]}),
			);

			return;
		}

		if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
			response.writeHead(404, {'content-type': 'application/json'});
			response.end(JSON.stringify({error: {message: 'not found'}}));

			return;
		}

		let body;

		try {
			body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			response.writeHead(400, {'content-type': 'application/json'});
			response.end(JSON.stringify({error: {message: 'invalid json'}}));

			return;
		}

		try {
			respond(response, body);
		} catch (error) {
			response.writeHead(500, {'content-type': 'application/json'});
			response.end(JSON.stringify({error: {message: String(error)}}));
		}
	});
});

server.listen(PORT, '127.0.0.1', () => {
	const address = server.address();
	process.stdout.write(`${JSON.stringify({port: address.port})}\n`);
});
