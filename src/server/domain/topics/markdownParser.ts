import crypto from "node:crypto";

import type {
  ParsedSection,
  ParsedTopic,
  ParsedTopicsDocument
} from "../types.js";

const headingPattern = /^##\s+(.+?)\s*$/;
const topLevelTopicPattern = /^- \[( |x)\] (.+?)(?:\s+<!--\s*(.+?)\s*-->)?\s*$/;
const childTopicPattern = /^\s{2,}- (.+?)(?:\s+<!--\s*(.+?)\s*-->)?\s*$/;
const idCommentPattern = /(?:^|\s)id:\s*([A-Za-z0-9._-]+)/;

function stableTopicId(sectionIndex: number, topicIndex: number, text: string): string {
  const hash = crypto.createHash("sha1").update(`${sectionIndex}:${topicIndex}:${text}`).digest("hex").slice(0, 8);
  return `tp_${hash}`;
}

function extractTopicId(comment: string | undefined, sectionIndex: number, topicIndex: number, text: string): string {
  if (comment) {
    const match = comment.match(idCommentPattern);
    if (match) {
      return match[1];
    }
  }

  return stableTopicId(sectionIndex, topicIndex, text);
}

export function parseTopicsMarkdown(markdown: string): ParsedTopicsDocument {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const leadingLines: string[] = [];
  const sections: ParsedSection[] = [];
  const topics: Record<string, ParsedTopic> = {};
  const topicIds: string[] = [];

  let currentSection: ParsedSection | null = null;
  let currentParentTopicId: string | null = null;
  let topicOrder = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const headingMatch = line.match(headingPattern);

    if (headingMatch) {
      currentSection = {
        heading: headingMatch[1],
        blocks: []
      };
      sections.push(currentSection);
      currentParentTopicId = null;
      continue;
    }

    const topLevelMatch = line.match(topLevelTopicPattern);
    if (topLevelMatch && currentSection) {
      const text = topLevelMatch[2].trim();
      const comment = topLevelMatch[3]?.trim();
      const topicId = extractTopicId(comment, sections.length, topicOrder, text);
      const topic: ParsedTopic = {
        id: topicId,
        parentId: null,
        section: currentSection.heading,
        text,
        kind: "cluster",
        checkbox: topLevelMatch[1] === "x",
        metadataComment: comment,
        children: [],
        originalOrder: topicOrder
      };

      topics[topicId] = topic;
      topicIds.push(topicId);
      currentSection.blocks.push({
        kind: "topic",
        topicId
      });
      currentParentTopicId = topicId;
      topicOrder += 1;
      continue;
    }

    const childMatch = line.match(childTopicPattern);
    if (childMatch && currentSection && currentParentTopicId) {
      const text = childMatch[1].trim();
      const comment = childMatch[2]?.trim();
      const topicId = extractTopicId(comment, sections.length, topicOrder, text);
      const childTopic: ParsedTopic = {
        id: topicId,
        parentId: currentParentTopicId,
        section: currentSection.heading,
        text,
        kind: "beat",
        checkbox: false,
        metadataComment: comment,
        children: [],
        originalOrder: topicOrder
      };

      topics[topicId] = childTopic;
      topics[currentParentTopicId].children.push(topicId);
      topicIds.push(topicId);
      topicOrder += 1;
      continue;
    }

    currentParentTopicId = null;

    if (currentSection) {
      currentSection.blocks.push({
        kind: "raw",
        line
      });
    } else {
      leadingLines.push(line);
    }
  }

  return {
    leadingLines,
    sections,
    topics,
    topicIds
  };
}
