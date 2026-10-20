import { GoogleGenAI } from '@google/genai';
import Document from '../models/Document.js';
import {
  refreshDocumentRagIndex,
  deleteDocumentRagIndex,
  answerDocumentQuestion
} from '../services/ragService.js';

/**
 * @desc    Process AI Assistant Action (rephrase, change tone, summarize, generate full doc)
 * @route   POST /api/ai/process
 * @access  Private
 */
export const processAiAction = async (req, res) => {
  try {
    const { action, prompt, text, tone } = req.body;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ message: 'Gemini API key is missing on the server.' });
    }

    const ai = new GoogleGenAI({ apiKey });

    let systemInstruction = '';
    let userPrompt = '';

    if (action === 'generate') {
      systemInstruction = 'You are an expert document author. Generate a well-structured, comprehensive document based on the user prompt using semantic HTML formatting (<p>, <h2>, <h3>, <ul>, <li>, <strong>, <em>, <table>). Do not include markdown code block syntax (like ```html), just output valid HTML.';
      userPrompt = `Create a complete document for: ${prompt}`;
    } else if (action === 'rephrase') {
      systemInstruction = 'You are a professional editor. Rephrase and improve the provided text for clarity, flow, and elegance. Keep the meaning intact. Output clean text or simple HTML if formatting exists.';
      userPrompt = `Rephrase this text: "${text}"`;
    } else if (action === 'tone') {
      systemInstruction = `You are a writing assistant. Adjust the tone of the provided text to be strictly ${tone || 'professional'}. Output clean text or simple HTML.`;
      userPrompt = `Change tone of this text to ${tone}: "${text}"`;
    } else if (action === 'summarize') {
      systemInstruction = 'You are an executive assistant. Provide a concise, bulleted HTML summary (using <ul> and <li> tags) of the provided text.';
      userPrompt = `Summarize this text: "${text}"`;
    } else {
      systemInstruction = 'You are an AI writing assistant. Assist the user with their document request.';
      userPrompt = prompt || text;
    }

    const candidateModels = [
      process.env.GEMINI_GENERATION_MODEL,
      'gemini-2.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
      'gemini-flash-latest'
    ].filter(Boolean);

    let response = null;
    let lastErr = null;

    for (const modelName of candidateModels) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents: userPrompt,
          config: { systemInstruction }
        });
        if (response && response.text) break;
      } catch (err) {
        lastErr = err;
        console.warn(`[AI Controller] Model ${modelName} failed (${err.message}), trying next fallback...`);
      }
    }

    if (!response) {
      throw lastErr || new Error('No working Gemini model found.');
    }

    const resultText = response.text || '';
    const cleanedResult = resultText
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    return res.json({ result: cleanedResult });
  } catch (error) {
    console.error('[AI Controller Error]:', error);
    return res.status(500).json({ message: error.message || 'Failed to process AI request' });
  }
};

/**
 * @desc    Index a document's text into the RAG retrieval store
 * @route   POST /api/ai/rag/index/:documentId
 * @access  Private / viewer access required
 */
export const indexDocumentForRag = async (req, res) => {
  try {
    const { documentId } = req.params;
    if (!documentId) {
      return res.status(400).json({ message: 'Document ID is required.' });
    }

    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ message: 'Document not found.' });
    }

    const currentUserId = req.user._id.toString();
    const ownerId = document.owner.toString();
    const isOwner = ownerId === currentUserId;
    const isCollaborator = document.collaborators?.some((entry) => {
      const collaboratorId = entry.userId?.toString();
      return collaboratorId === currentUserId;
    });
    const isAnyoneWithLink = document.visibility === 'anyone-with-link';

    if (!isOwner && !isCollaborator && !isAnyoneWithLink) {
      return res.status(403).json({ message: 'You do not have permission to index this document.' });
    }

    const result = await refreshDocumentRagIndex(documentId, true);
    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[AI RAG Index Error]:', error);
    return res.status(500).json({ message: error.message || 'Failed to index the document for RAG.' });
  }
};

/**
 * @desc    Ask a question about an authorized document
 * @route   POST /api/ai/rag/ask
 * @access  Private
 */
export const askDocumentRag = async (req, res) => {
  try {
    const { documentId, question } = req.body || {};
    if (!documentId) {
      return res.status(400).json({ message: 'Document ID is required.' });
    }

    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ message: 'Document not found.' });
    }

    const currentUserId = req.user._id.toString();
    const ownerId = document.owner.toString();
    const isOwner = ownerId === currentUserId;
    const collaborator = document.collaborators?.find((entry) => entry.userId?.toString() === currentUserId);
    const hasViewerAccess = isOwner || !!collaborator || document.visibility === 'anyone-with-link';

    if (!hasViewerAccess) {
      return res.status(403).json({ message: 'You do not have access to this document.' });
    }

    const result = await answerDocumentQuestion(documentId, question);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AI RAG Query Error]:', error);
    return res.status(500).json({ message: error.message || 'Failed to answer the document question.' });
  }
};

/**
 * @desc    Remove stored embeddings for a document
 * @route   DELETE /api/ai/rag/index/:documentId
 * @access  Private / owner only
 */
export const removeDocumentRagIndex = async (req, res) => {
  try {
    const { documentId } = req.params;
    if (!documentId) {
      return res.status(400).json({ message: 'Document ID is required.' });
    }

    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ message: 'Document not found.' });
    }

    const currentUserId = req.user._id.toString();
    if (document.owner.toString() !== currentUserId) {
      return res.status(403).json({ message: 'Only the document owner can remove its RAG index.' });
    }

    const result = await deleteDocumentRagIndex(documentId);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AI RAG Delete Error]:', error);
    return res.status(500).json({ message: error.message || 'Failed to remove the document RAG index.' });
  }
};
