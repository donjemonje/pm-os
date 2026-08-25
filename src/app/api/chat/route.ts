import { NextRequest, NextResponse } from "next/server";
import { apiAuthContext } from "@/lib/api-auth";
import { db } from "@/lib/db";
import {
  fetchIssuesByKeys,
  fetchIssuesForVersion,
  fetchRecentDoneIssues,
  addJiraComment,
} from "@/lib/jira";
import { answerOrgQuestion, answerPrdQuestion, chatAssist } from "@/lib/ai";
import { formatApiAiError, isAiEnabled } from "@/lib/ai";
import { getOrgCatalog } from "@/lib/org-catalog";
import { executeRetrievalPlan, routeChatQuestion } from "@/lib/chat-router";
import { parseJsonObject } from "@/lib/utils";
import type { ChatContext, ChatMessageMetadata } from "@/lib/types";

const DEFAULT_PRD_QUESTION =
  /what|how|when|where|why|should|edge case|acceptance|requirement|behavior|happens if|can user/i;

type HistoryMessage = { role: "user" | "assistant"; content: string };

async function recentHistory(sessionId: string, take = 8): Promise<HistoryMessage[]> {
  const rows = await db.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.reverse().map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
}

export async function POST(request: NextRequest) {
  const auth = await apiAuthContext();
  if (auth instanceof NextResponse) return auth;
  const { workspaceId, userId } = auth;
  const { message, sessionId, context } = (await request.json()) as {
    message: string;
    sessionId?: string;
    context?: ChatContext;
  };

  if (!message?.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  if (!isAiEnabled()) {
    return NextResponse.json(
      {
        error:
          "AI is not configured. Set VERTEX_PROJECT_ID and Google Application Default Credentials.",
      },
      { status: 503 }
    );
  }

  let session = sessionId
    ? await db.chatSession.findFirst({
        where: {
          id: sessionId,
          workspaceId,
          OR: [{ userId }, { userId: null }],
        },
      })
    : null;

  if (session && !session.userId) {
    session = await db.chatSession.update({
      where: { id: session.id },
      data: { userId },
    });
  }

  if (!session) {
    session = await db.chatSession.create({
      data: {
        workspaceId,
        userId,
        title: message.slice(0, 60),
        context: JSON.stringify(context ?? {}),
      },
    });
  }

  await db.chatMessage.create({
    data: { sessionId: session.id, role: "user", content: message },
  });

  const chatContext = context ?? parseJsonObject<ChatContext>(session.context, {});
  const hasExplicitContext = Boolean(
    chatContext.issueKeys?.length ||
      chatContext.releaseId ||
      chatContext.documentId ||
      chatContext.projectKey
  );

  const metadata: ChatMessageMetadata = {};

  try {
    let reply: string;

    if (hasExplicitContext) {
      // Deterministic path: the UI already scoped the context (release page,
      // document page, issue picker) — fetch exactly that, no routing.
      let issues: Awaited<ReturnType<typeof fetchIssuesByKeys>> = [];
      let documentContext = "";

      if (chatContext.issueKeys?.length) {
        issues = await fetchIssuesByKeys(workspaceId, chatContext.issueKeys);
      } else if (chatContext.releaseId) {
        const release = await db.release.findFirst({
          where: { id: chatContext.releaseId, workspaceId },
        });
        if (release?.jiraVersionName) {
          issues = await fetchIssuesForVersion(
            workspaceId,
            release.jiraProjectKey,
            release.jiraVersionName
          );
        } else if (release?.jiraProjectKey) {
          issues = await fetchRecentDoneIssues(workspaceId, release.jiraProjectKey);
        }
      } else if (chatContext.projectKey) {
        issues = await fetchRecentDoneIssues(workspaceId, chatContext.projectKey);
      }

      if (chatContext.documentId) {
        const doc = await db.document.findFirst({
          where: { id: chatContext.documentId, workspaceId },
        });
        if (doc) {
          documentContext = `# ${doc.title}\n\n${doc.body}`;
          metadata.embed = {
            type: "document",
            id: doc.id,
            title: doc.title,
            preview: doc.body.slice(0, 400),
          };
        }
      }

      const isPrdQuestion = DEFAULT_PRD_QUESTION.test(message);

      if (isPrdQuestion && issues.length > 0) {
        const result = await answerPrdQuestion(message, issues, documentContext, {
          cacheScope: workspaceId,
        });
        reply = result.answer;
        metadata.citations = result.citations;
        metadata.confidence = result.confidence;

        await db.qALog.create({
          data: {
            workspaceId,
            issueKey: chatContext.issueKeys?.[0] ?? issues[0]?.key ?? null,
            question: message,
            answer: reply,
            citations: JSON.stringify(result.citations),
            confidence: result.confidence,
          },
        });

        if (result.confidence === "high" && chatContext.issueKeys?.[0]) {
          try {
            await addJiraComment(
              workspaceId,
              chatContext.issueKeys[0],
              `[PMOS] Q: ${message}\n\nA: ${reply.slice(0, 500)}`
            );
          } catch {
            // Non-blocking
          }
        }
      } else {
        const history = await recentHistory(session.id);
        const systemContext = [
          documentContext,
          issues.length
            ? `Jira issues:\n${issues.map((i) => `[${i.key}] ${i.summary}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        reply = await chatAssist(history, systemContext, { cacheScope: workspaceId });
      }
    } else {
      // Org Q&A path: route the question against the org catalog, fetch only
      // what the plan asks for, then answer from the retrieved context.
      const history = await recentHistory(session.id);
      const priorTurns = history.slice(0, -1);
      const catalog = await getOrgCatalog(workspaceId);

      let retrieved = null;
      if (catalog.jiraConnected || catalog.driveConnected) {
        const plan = await routeChatQuestion(message, catalog, priorTurns, {
          cacheScope: workspaceId,
        });
        retrieved = await executeRetrievalPlan(workspaceId, plan);
      }

      if (retrieved?.used && (retrieved.issues.length || retrieved.driveFiles.length)) {
        const result = await answerOrgQuestion(message, retrieved, priorTurns, {
          cacheScope: workspaceId,
        });
        reply = result.answer;
        metadata.citations = result.citations;
        metadata.confidence = result.confidence;

        await db.qALog.create({
          data: {
            workspaceId,
            issueKey: retrieved.issues[0]?.key ?? null,
            question: message,
            answer: reply,
            citations: JSON.stringify(result.citations),
            confidence: result.confidence,
          },
        });
      } else {
        const emptyRetrievalNote = retrieved?.used
          ? "The user's question looked like it needed org data, but nothing matching was found in Jira or Drive — say so and suggest rephrasing or connecting more sources."
          : "";
        reply = await chatAssist(history, emptyRetrievalNote, { cacheScope: workspaceId });
      }
    }

    await db.chatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: reply,
        metadata: JSON.stringify(metadata),
      },
    });

    await db.chatSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });

    return NextResponse.json({
      sessionId: session.id,
      reply,
      metadata,
    });
  } catch (err) {
    const { message: errorMessage, status } = formatApiAiError(err);
    return NextResponse.json({ error: errorMessage }, { status });
  }
}
