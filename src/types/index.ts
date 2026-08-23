export interface ReadDocumentParams {
  file_path: string
  format?: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'auto'
  offset?: number
  limit?: number
}

export interface WriteDocumentParams {
  file_path: string
  format: 'docx' | 'xlsx' | 'csv' | 'pdf'
  content: Record<string, unknown>
}

export interface ReadResult {
  content: string
  total_lines?: number
  offset?: number
  limit?: number
  format: string
  /** PDF 页数（仅 PDF） */
  pages?: number
  /** 结果因 limit 被截断（仅 CSV/XLSX） */
  truncated?: boolean
  /** 解析器警告信息（如 DOCX 转换消息） */
  warnings?: string[]
}
