import mongoose from 'mongoose';

const documentRagChunkSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Document',
      required: true,
      index: true
    },
    chunkIndex: {
      type: Number,
      required: true,
      default: 0,
      index: true
    },
    heading: {
      type: String,
      default: 'Section'
    },
    text: {
      type: String,
      required: true,
      trim: true
    },
    embedding: {
      type: [Number],
      default: []
    },
    tokenCount: {
      type: Number,
      default: 0
    },
    hash: {
      type: String,
      default: ''
    },
    startOffset: {
      type: Number,
      default: 0
    },
    endOffset: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

documentRagChunkSchema.index({ documentId: 1, chunkIndex: 1 }, { unique: true });

const DocumentRagChunk = mongoose.model('DocumentRagChunk', documentRagChunkSchema);
export default DocumentRagChunk;
