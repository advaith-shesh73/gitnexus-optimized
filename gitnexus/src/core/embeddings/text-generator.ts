/**
 * Text Generator Module
 * 
 * Pure functions to generate embedding text from code nodes.
 * Combines node metadata with code snippets for semantic matching.
 */

import type { EmbeddableNode, EmbeddingConfig } from './types.js';
import { DEFAULT_EMBEDDING_CONFIG } from './types.js';

/**
 * Extract the filename from a file path
 */
const getFileName = (filePath: string): string => {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
};

/**
 * Extract the directory path from a file path
 */
const getDirectory = (filePath: string): string => {
  const parts = filePath.split('/');
  parts.pop();
  return parts.join('/') || '';
};

/**
 * Truncate content to max length, preserving word boundaries
 */
const truncateContent = (content: string, maxLength: number): string => {
  if (content.length <= maxLength) {
    return content;
  }
  
  // Find last space before maxLength to avoid cutting words
  const truncated = content.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  
  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace) + '...';
  }
  
  return truncated + '...';
};

/**
 * Clean code content for embedding
 * Removes excessive whitespace while preserving structure
 */
const cleanContent = (content: string): string => {
  return content
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    // Remove excessive blank lines (more than 2)
    .replace(/\n{3,}/g, '\n\n')
    // Trim each line
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
};

/**
 * Generate embedding text for a File node.
 * Uses file name and path prefix; shorter snippet since files can be very long.
 */
const generateFileText = (
  node: EmbeddableNode,
  maxSnippetLength: number
): string => {
  const parts: string[] = [
    `File: ${node.name}`,
    `Path: ${node.filePath}`,
  ];

  if (node.content) {
    const cleanedContent = cleanContent(node.content);
    const snippet = truncateContent(cleanedContent, Math.min(maxSnippetLength, 300));
    parts.push('', snippet);
  }

  return parts.join('\n');
};

/**
 * Generate embedding text for any code-element node.
 * The label (Function, Class, Struct, Enum, etc.) is used as a semantic prefix
 * so the embedding captures both the type and the content.
 */
const generateCodeElementText = (
  node: EmbeddableNode,
  maxSnippetLength: number
): string => {
  const parts: string[] = [
    `${node.label}: ${node.name}`,
    `File: ${getFileName(node.filePath)}`,
  ];

  const dir = getDirectory(node.filePath);
  if (dir) {
    parts.push(`Directory: ${dir}`);
  }

  if (node.content) {
    const cleanedContent = cleanContent(node.content);
    const snippet = truncateContent(cleanedContent, maxSnippetLength);
    parts.push('', snippet);
  }

  return parts.join('\n');
};

/**
 * Generate embedding text for any embeddable node.
 * File nodes get a specialized generator (shorter snippets, path-based prefix).
 * All other nodes use the generic code-element generator which prefixes with
 * the node label (Function, Class, Struct, Enum, etc.).
 */
export const generateEmbeddingText = (
  node: EmbeddableNode,
  config: Partial<EmbeddingConfig> = {}
): string => {
  const maxSnippetLength = config.maxSnippetLength ?? DEFAULT_EMBEDDING_CONFIG.maxSnippetLength;

  if (node.label === 'File') {
    return generateFileText(node, maxSnippetLength);
  }
  return generateCodeElementText(node, maxSnippetLength);
};

/**
 * Generate embedding texts for a batch of nodes
 * 
 * @param nodes - Array of nodes to generate text for
 * @param config - Optional configuration
 * @returns Array of texts in the same order as input nodes
 */
export const generateBatchEmbeddingTexts = (
  nodes: EmbeddableNode[],
  config: Partial<EmbeddingConfig> = {}
): string[] => {
  return nodes.map(node => generateEmbeddingText(node, config));
};

