/**
 * The capture write itself: one inbox item -> `TdaiCore.handleTurnCommitted`.
 *
 * Shared by the two places that drain the capture inbox: the gateway process in
 * inline mode (`TDAI_WORKER=inline`, tests) and the worker process (default).
 */
import type { TdaiCore } from "../core/tdai-core.js";
import type { InboxItem } from "../core/capture-inbox.js";
import type { Logger } from "../core/types.js";
import type { CaptureRequest } from "./types.js";

export function createCaptureProcessor(
  core: TdaiCore,
  logger: Logger,
): (item: InboxItem<CaptureRequest>) => Promise<void> {
  return async ({ id, body }) => {
    const startMs = Date.now();
    const result = await core.handleTurnCommitted({
      userText: body.user_content,
      assistantText: body.assistant_content,
      messages: body.messages ?? [
        { role: "user", content: body.user_content },
        { role: "assistant", content: body.assistant_content },
      ],
      sessionKey: body.session_key,
      sessionId: body.session_id,
    });
    logger.info(
      `Capture ${id} written in ${Date.now() - startMs}ms: l0=${result.l0RecordedCount} session=${body.session_key}`,
    );
  };
}
