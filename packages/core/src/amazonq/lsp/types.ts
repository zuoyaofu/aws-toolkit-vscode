/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { RequestType } from 'vscode-languageserver'

export type IndexRequestPayload = {
    filePaths: string[]
    rootPath: string
    refresh: boolean
}

export type ClearRequest = string

export const ClearRequestType: RequestType<ClearRequest, any, any> = new RequestType('lsp/clear')

export type QueryRequest = string

export const QueryRequestType: RequestType<QueryRequest, any, any> = new RequestType('lsp/query')

export type GetUsageRequest = string

export const GetUsageRequestType: RequestType<GetUsageRequest, any, any> = new RequestType('lsp/getUsage')

export interface Usage {
    memoryUsage: number
    cpuUsage: number
}

export type BuildIndexRequestPayload = {
    filePaths: string[]
    projectRoot: string
    config: string
    language: string
}

export type BuildIndexRequest = string

export const BuildIndexRequestType: RequestType<BuildIndexRequest, any, any> = new RequestType('lsp/buildIndex')

export type UpdateIndexV2Request = string

export type UpdateIndexV2RequestPayload = { filePaths: string[]; updateMode: string }

export const UpdateIndexV2RequestType: RequestType<UpdateIndexV2Request, any, any> = new RequestType(
    'lsp/updateIndexV2'
)

export type QueryInlineProjectContextRequest = string
export type QueryInlineProjectContextRequestPayload = {
    query: string
    filePath: string
    target: string
}
export const QueryInlineProjectContextRequestType: RequestType<QueryInlineProjectContextRequest, any, any> =
    new RequestType('lsp/queryInlineProjectContext')

export type QueryVectorIndexRequestPayload = { query: string }

export type QueryVectorIndexRequest = string

export const QueryVectorIndexRequestType: RequestType<QueryVectorIndexRequest, any, any> = new RequestType(
    'lsp/queryVectorIndex'
)

export type IndexConfig = 'all' | 'default'

// RepoMapData
export type QueryRepomapIndexRequestPayload = { filePaths: string[] }
export type QueryRepomapIndexRequest = string
export const QueryRepomapIndexRequestType: RequestType<QueryRepomapIndexRequest, any, any> = new RequestType(
    'lsp/queryRepomapIndex'
)
export type GetRepomapIndexJSONRequest = string
export const GetRepomapIndexJSONRequestType: RequestType<GetRepomapIndexJSONRequest, any, any> = new RequestType(
    'lsp/getRepomapIndexJSON'
)

export type GetContextCommandItemsRequestPayload = { workspaceFolders: string[] }
export type GetContextCommandItemsRequest = string
export const GetContextCommandItemsRequestType: RequestType<GetContextCommandItemsRequest, any, any> = new RequestType(
    'lsp/getContextCommandItems'
)

export type GetIndexSequenceNumberRequest = string
export const GetIndexSequenceNumberRequestType: RequestType<GetRepomapIndexJSONRequest, any, any> = new RequestType(
    'lsp/getIndexSequenceNumber'
)

export type ContextCommandItemType = 'file' | 'folder' | 'code'

export type SymbolType =
    | 'Class'
    | 'Function'
    | 'Interface'
    | 'Type'
    | 'Enum'
    | 'Struct'
    | 'Delegate'
    | 'Namespace'
    | 'Object'
    | 'Module'
    | 'Method'

export interface Position {
    line: number
    column: number
}
export interface Span {
    start: Position
    end: Position
}

// LSP definition of DocumentSymbol

export interface DocumentSymbol {
    name: string
    kind: SymbolType
    range: Span
}

export interface ContextCommandItem {
    workspaceFolder: string
    type: ContextCommandItemType
    relativePath: string
    symbol?: DocumentSymbol
    id?: string
}

export type GetContextCommandPromptRequestPayload = {
    contextCommands: {
        workspaceFolder: string
        type: 'file' | 'folder'
        relativePath: string
    }[]
}
export type GetContextCommandPromptRequest = string
export const GetContextCommandPromptRequestType: RequestType<GetContextCommandPromptRequest, any, any> =
    new RequestType('lsp/getContextCommandPrompt')

export interface AdditionalContextPrompt {
    content: string
    name: string
    description: string
    startLine: number
    endLine: number
    filePath: string
    relativePath: string
}
