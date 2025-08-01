/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { DiffTreeFileInfo } from '../webview/ui/diffTree/types'
import { FeatureClient } from '../client/client'
import { MynahUI } from '@aws/mynah-ui'

export enum FollowUpTypes {
    // UnitTestGeneration
    ViewDiff = 'ViewDiff',
    AcceptCode = 'AcceptCode',
    RejectCode = 'RejectCode',
    BuildAndExecute = 'BuildAndExecute',
    ModifyCommands = 'ModifyCommands',
    SkipBuildAndFinish = 'SkipBuildAndFinish',
    InstallDependenciesAndContinue = 'InstallDependenciesAndContinue',
    ContinueBuildAndExecute = 'ContinueBuildAndExecute',
    ViewCodeDiffAfterIteration = 'ViewCodeDiffAfterIteration',
    // FeatureDev
    GenerateCode = 'GenerateCode',
    InsertCode = 'InsertCode',
    ProvideFeedbackAndRegenerateCode = 'ProvideFeedbackAndRegenerateCode',
    Retry = 'Retry',
    ModifyDefaultSourceFolder = 'ModifyDefaultSourceFolder',
    DevExamples = 'DevExamples',
    NewTask = 'NewTask',
    CloseSession = 'CloseSession',
    SendFeedback = 'SendFeedback',
    AcceptAutoBuild = 'AcceptAutoBuild',
    DenyAutoBuild = 'DenyAutoBuild',
    GenerateDevFile = 'GenerateDevFile',
    // Doc
    CreateDocumentation = 'CreateDocumentation',
    ChooseFolder = 'ChooseFolder',
    UpdateDocumentation = 'UpdateDocumentation',
    SynchronizeDocumentation = 'SynchronizeDocumentation',
    EditDocumentation = 'EditDocumentation',
    AcceptChanges = 'AcceptChanges',
    RejectChanges = 'RejectChanges',
    MakeChanges = 'MakeChanges',
    ProceedFolderSelection = 'ProceedFolderSelection',
    CancelFolderSelection = 'CancelFolderSelection',
}

export type Interaction = {
    // content to be sent back to the chat UI
    content?: string
    responseType?: LLMResponseType
}

export enum Intent {
    DEV = 'DEV',
    DOC = 'DOC',
}

export enum DevPhase {
    INIT = 'Init',
    APPROACH = 'Approach',
    CODEGEN = 'Codegen',
}

export enum CodeGenerationStatus {
    COMPLETE = 'Complete',
    PREDICT_READY = 'predict-ready',
    IN_PROGRESS = 'InProgress',
    PREDICT_FAILED = 'predict-failed',
    DEBATE_FAILED = 'debate-failed',
    FAILED = 'Failed',
}

export type SessionStatePhase = DevPhase.INIT | DevPhase.CODEGEN

export type CurrentWsFolders = [vscode.WorkspaceFolder, ...vscode.WorkspaceFolder[]]

export interface SessionStateConfig {
    workspaceRoots: string[]
    workspaceFolders: CurrentWsFolders
    conversationId: string
    proxyClient: FeatureClient
    uploadId: string
    currentCodeGenerationId?: string
}

export type NewFileZipContents = { zipFilePath: string; fileContent: string }
export type NewFileInfo = DiffTreeFileInfo &
    NewFileZipContents & {
        virtualMemoryUri: vscode.Uri
        workspaceFolder: vscode.WorkspaceFolder
    }

export type DeletedFileInfo = DiffTreeFileInfo & {
    workspaceFolder: vscode.WorkspaceFolder
}

export interface SessionInfo {
    // TODO, if it had a summarized name that was better for the UI
    name?: string
    history: string[]
}

export interface SessionStorage {
    [key: string]: SessionInfo
}

export type LLMResponseType = 'EMPTY' | 'INVALID_STATE' | 'VALID'

export interface UpdateFilesPathsParams {
    tabID: string
    filePaths: NewFileInfo[]
    deletedFiles: DeletedFileInfo[]
    messageId: string
    disableFileActions?: boolean
}

export enum MetricDataOperationName {
    StartCodeGeneration = 'StartCodeGeneration',
    EndCodeGeneration = 'EndCodeGeneration',
}

export enum MetricDataResult {
    Success = 'Success',
    Fault = 'Fault',
    Error = 'Error',
    LlmFailure = 'LLMFailure',
}

/**
 * Note: Passing a reference around allows us to lazily inject mynah UI into
 * connectors and handlers. This is done to supported "hybrid chat", which
 * injects mynah UI _after_ the connector has already been created
 */
export type MynahUIRef = { mynahUI: MynahUI | undefined }
