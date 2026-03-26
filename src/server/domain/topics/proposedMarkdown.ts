import type { ParsedTopic, SessionSnapshot, TopicRecord, TopicState } from "../types.js";

function topicComment(topic: TopicRecord, sessionId: string): string {
  switch (topic.currentState) {
    case "covered":
      return `<!-- id: ${topic.id}; covered: ${sessionId} -->`;
    case "partial":
      return `<!-- id: ${topic.id}; partial: ${sessionId} -->`;
    case "dismissed":
      return `<!-- id: ${topic.id}; dismissed -->`;
    case "snoozed":
      return `<!-- id: ${topic.id}; snoozed -->`;
    default:
      return `<!-- id: ${topic.id} -->`;
  }
}

function topicCheckbox(state: TopicState): string {
  switch (state) {
    case "covered":
      return "[x]";
    case "partial":
      return "[~]";
    case "snoozed":
      return "[>]";
    case "dismissed":
      return "[-]";
    default:
      return "[ ]";
  }
}

function renderMovedTopic(topic: TopicRecord, topics: Record<string, TopicRecord>, sessionId: string): string[] {
  if (topic.kind === "beat" && topic.parentId) {
    const parentText = topics[topic.parentId]?.text;
    return [`- ${topicCheckbox(topic.currentState)} ${parentText ? `${parentText} > ${topic.text}` : topic.text} ${topicComment(topic, sessionId)}`];
  }

  const lines = [`- ${topicCheckbox(topic.currentState)} ${topic.text} ${topicComment(topic, sessionId)}`];

  for (const childId of topic.children) {
    const child = topics[childId];
    if (!child) {
      continue;
    }

    lines.push(`  - ${topicCheckbox(child.currentState)} ${child.text} ${topicComment(child, sessionId)}`);
  }

  return lines;
}

function shouldMove(topic: ParsedTopic & { currentState: TopicState; }, parentMoved: boolean): boolean {
  if (parentMoved) {
    return false;
  }

  return topic.currentState === "covered" || topic.currentState === "dismissed";
}

function renderTopicInPlace(topic: TopicRecord, topics: Record<string, TopicRecord>, sessionId: string): string[] {
  const lines = [`- ${topicCheckbox(topic.currentState)} ${topic.text} ${topicComment(topic, sessionId)}`];

  for (const childId of topic.children) {
    const child = topics[childId];
    if (!child || child.currentState === "covered" || child.currentState === "dismissed") {
      continue;
    }

    lines.push(`  - ${topicCheckbox(child.currentState)} ${child.text} ${topicComment(child, sessionId)}`);
  }

  return lines;
}

function renderTouchedTopic(topic: TopicRecord, topics: Record<string, TopicRecord>, sessionId: string): string[] {
  if (topic.kind === "beat" && topic.parentId) {
    const parentText = topics[topic.parentId]?.text;
    return [`- ${topicCheckbox(topic.currentState)} ${parentText ? `${parentText} > ${topic.text}` : topic.text} ${topicComment(topic, sessionId)}`];
  }

  const lines = [`- ${topicCheckbox(topic.currentState)} ${topic.text} ${topicComment(topic, sessionId)}`];

  for (const childId of topic.children) {
    const child = topics[childId];
    if (!child || child.currentState !== "partial") {
      continue;
    }

    lines.push(`  - ${topicCheckbox(child.currentState)} ${child.text} ${topicComment(child, sessionId)}`);
  }

  return lines;
}

export function buildProposedMarkdown(session: SessionSnapshot): string {
  const lines: string[] = [...session.document.leadingLines];
  const touchedLines: string[] = [];
  const doneLines: string[] = [];
  const dismissedLines: string[] = [];

  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }

  for (const section of session.document.sections) {
    lines.push(`## ${section.heading}`);

    for (const block of section.blocks) {
      if (block.kind === "raw") {
        lines.push(block.line);
        continue;
      }

      const topic = session.topics[block.topicId];
      if (!topic) {
        continue;
      }

      const moved = shouldMove(topic, false);
      if (moved) {
        const target = topic.currentState === "covered" ? doneLines : dismissedLines;
        target.push(...renderMovedTopic(topic, session.topics, session.id));
        continue;
      }

      lines.push(...renderTopicInPlace(topic, session.topics, session.id));
      if (topic.currentState === "partial") {
        touchedLines.push(...renderTouchedTopic(topic, session.topics, session.id));
      }
    }

    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }
  }

  lines.push("## Done");
  if (doneLines.length > 0) {
    lines.push(...doneLines);
  }
  lines.push("");
  lines.push("## Touched This Session");
  if (touchedLines.length > 0) {
    lines.push(...touchedLines);
  }
  lines.push("");
  lines.push("## Dismissed");
  if (dismissedLines.length > 0) {
    lines.push(...dismissedLines);
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
