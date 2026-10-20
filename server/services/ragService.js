import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import Document from '../models/Document.js';
import DocumentRagChunk from '../models/DocumentRagChunk.js';

const DEFAULT_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const DEFAULT_GENERATION_MODEL = process.env.GEMINI_GENERATION_MODEL || 'gemini-2.5-flash-lite';

const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key is missing on the server.');
  }

  return new GoogleGenAI({ apiKey });
};

const escapeHtmlText = (value = '') => {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
};

export const normalizeDocumentText = (rawContent = '') => {
  if (!rawContent) return '';

  let text = typeof rawContent === 'string' ? rawContent : String(rawContent);

  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|section|article|blockquote|h[1-6]|li|ul|ol|tr|td|th)\s*>/gi, '\n')
      .replace(/<li\s*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '\n');
  }

  text = escapeHtmlText(text)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\s+\n\s+/g, '\n\n')
    .trim();

  return text;
};

const splitParagraphs = (text) => {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (paragraphs.length > 0) return paragraphs;

  return text
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
};

export const buildRagChunks = (rawContent = '', options = {}) => {
  const maxChars = options.maxChars || 1200;
  const normalized = normalizeDocumentText(rawContent);

  if (!normalized) return [];

  const paragraphs = splitParagraphs(normalized);
  const output = [];
  let buffer = '';

  const flushBuffer = () => {
    if (!buffer.trim()) return;
    output.push(buffer.trim());
    buffer = '';
  };

  for (const paragraph of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;

    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }

    if (buffer) {
      flushBuffer();
    }

    if (paragraph.length > maxChars) {
      const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
      let sentenceBuffer = '';

      for (const sentence of sentences) {
        const nextCandidate = sentenceBuffer ? `${sentenceBuffer} ${sentence}` : sentence;

        if (nextCandidate.length <= maxChars) {
          sentenceBuffer = nextCandidate;
          continue;
        }

        if (sentenceBuffer) {
          output.push(sentenceBuffer.trim());
          sentenceBuffer = sentence;
        } else {
          output.push(sentence.slice(0, maxChars).trim());
          const remainder = sentence.slice(maxChars).trim();
          if (remainder) sentenceBuffer = remainder;
        }
      }

      if (sentenceBuffer) {
        output.push(sentenceBuffer.trim());
      }
    } else {
      buffer = paragraph;
    }
  }

  flushBuffer();

  return output
    .filter((chunk) => chunk && chunk.length > 30)
    .map((chunk, index) => ({
      index: index + 1,
      heading: `Section ${index + 1}`,
      text: chunk.trim()
    }));
};

const cosineSimilarity = (vectorA, vectorB) => {
  if (!Array.isArray(vectorA) || !Array.isArray(vectorB) || !vectorA.length || !vectorB.length) {
    return 0;
  }

  const length = Math.min(vectorA.length, vectorB.length);
  let dotProduct = 0;
  let sumA = 0;
  let sumB = 0;

  for (let i = 0; i < length; i += 1) {
    dotProduct += vectorA[i] * vectorB[i];
    sumA += vectorA[i] * vectorA[i];
    sumB += vectorB[i] * vectorB[i];
  }

  if (!sumA || !sumB) return 0;

  return dotProduct / (Math.sqrt(sumA) * Math.sqrt(sumB));
};

const createEmbedding = async (text, taskType = 'RETRIEVAL_DOCUMENT') => {
  const ai = getGeminiClient();
  const model = process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;

  const response = await ai.models.embedContent({
    model,
    contents: text,
    config: {
      taskType
    }
  });

  const values = response?.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Gemini returned no embedding values for the provided text.');
  }

  return values;
};

export const refreshDocumentRagIndex = async (documentId, forceRefresh = false) => {
  const document = await Document.findById(documentId).lean();
  if (!document) {
    throw new Error('Document not found');
  }

  const rawContent = document.content || '';
  const normalizedContent = normalizeDocumentText(rawContent);
  const contentHash = crypto.createHash('sha256').update(normalizedContent).digest('hex');

  const existingChunkCount = await DocumentRagChunk.countDocuments({ documentId });
  if (!forceRefresh && document.ragContentHash === contentHash && existingChunkCount > 0) {
    return {
      message: 'Document already indexed for RAG. No refresh required.',
      documentId,
      indexed: false,
      chunkCount: existingChunkCount
    };
  }

  const chunks = buildRagChunks(normalizedContent);

  if (!chunks.length) {
    await DocumentRagChunk.deleteMany({ documentId });
    await Document.findByIdAndUpdate(documentId, {
      $set: {
        ragContentHash: contentHash,
        ragIndexedAt: new Date(),
        ragChunkCount: 0
      }
    });

    return {
      documentId,
      indexed: false,
      chunkCount: 0,
      message: 'Document has no text content to index.'
    };
  }

  const successfulChunks = [];

  for (const chunk of chunks) {
    try {
      const embedding = await createEmbedding(chunk.text, 'RETRIEVAL_DOCUMENT');
      successfulChunks.push({
        documentId,
        chunkIndex: chunk.index,
        heading: chunk.heading,
        text: chunk.text,
        embedding,
        tokenCount: chunk.text.split(/\s+/).filter(Boolean).length,
        hash: crypto.createHash('sha256').update(chunk.text).digest('hex'),
        startOffset: 0,
        endOffset: chunk.text.length
      });
    } catch (error) {
      console.warn(`[RAG] Failed to embed chunk ${chunk.index} for document ${documentId}:`, error.message);
    }
  }

  if (!successfulChunks.length) {
    throw new Error('Failed to generate embeddings for the document. Please try again later.');
  }

  await DocumentRagChunk.deleteMany({ documentId });
  await DocumentRagChunk.insertMany(successfulChunks);

  await Document.findByIdAndUpdate(documentId, {
    $set: {
      ragContentHash: contentHash,
      ragIndexedAt: new Date(),
      ragChunkCount: successfulChunks.length
    }
  });

  return {
    documentId,
    indexed: true,
    chunkCount: successfulChunks.length,
    message: `Indexed ${successfulChunks.length} document chunks successfully.`
  };
};

export const deleteDocumentRagIndex = async (documentId) => {
  await DocumentRagChunk.deleteMany({ documentId });
  await Document.findByIdAndUpdate(documentId, {
    $set: {
      ragContentHash: null,
      ragIndexedAt: null,
      ragChunkCount: 0
    }
  });

  return {
    documentId,
    deleted: true,
    message: 'Document RAG index was removed successfully.'
  };
};

export const answerDocumentQuestion = async (documentId, question) => {
  const document = await Document.findById(documentId);
  if (!document) {
    throw new Error('Document not found');
  }

  const questionText = String(question || '').trim();
  if (!questionText) {
    throw new Error('Please provide a question to ask about the document.');
  }

  const contentHash = crypto
    .createHash('sha256')
    .update(normalizeDocumentText(document.content || ''))
    .digest('hex');

  if (!document.ragContentHash || document.ragContentHash !== contentHash) {
    await refreshDocumentRagIndex(documentId, false);
  }

  const chunks = await DocumentRagChunk.find({ documentId }).sort({ chunkIndex: 1 }).lean();
  if (!chunks.length) {
    throw new Error('This document has not been indexed yet. Use the Index Document action first.');
  }

  const questionEmbedding = await createEmbedding(questionText, 'RETRIEVAL_QUERY');

  const scoredChunks = chunks
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(questionEmbedding, chunk.embedding || [])
    }))
    .filter((chunk) => Number.isFinite(chunk.score))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const topChunks = scoredChunks.slice(0, 4);

  if (!topChunks.length) {
    throw new Error('The document index exists, but no relevant chunks could be matched for your question.');
  }

  const context = topChunks
    .map((chunk, index) => `[Source ${index + 1}] ${chunk.text}`)
    .join('\n\n');

  const ai = getGeminiClient();
  const model = process.env.GEMINI_GENERATION_MODEL || DEFAULT_GENERATION_MODEL;

  const response = await ai.models.generateContent({
    model,
    contents: `Answer the user's question using only the document context below. If the document does not contain enough evidence, say that clearly. Do not invent or assume facts beyond the provided passages. Include a small list of source references at the end using the numbers shown in the excerpts.\n\nQuestion: ${questionText}\n\nContext:\n${context}`,
    config: {
      systemInstruction: 'You are a careful document Q&A assistant. Base your answer strictly on the provided context. If the answer is uncertain or missing, state that clearly instead of guessing. Prefer concise, evidence-based answers. When citing sources, refer to the numbered passage references from the retrieved context.'
    }
  });

  const answerText = response?.text || 'No answer could be generated from the available document context.';

  return {
    answer: answerText.trim(),
    references: topChunks.map((chunk, idx) => ({
      sourceIndex: idx + 1,
      chunkIndex: chunk.chunkIndex,
      heading: chunk.heading || `Section ${chunk.chunkIndex}`,
      score: Number((chunk.score || 0).toFixed(4)),
      excerpt: chunk.text.slice(0, 500)
    })),
    documentId,
    question: questionText
  };
};
