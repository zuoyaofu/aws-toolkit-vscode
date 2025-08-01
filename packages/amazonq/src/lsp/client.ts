/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import vscode, { env, version } from 'vscode'
import * as nls from 'vscode-nls'
import { LanguageClient, LanguageClientOptions, RequestType, State } from 'vscode-languageclient'
import { InlineCompletionManager } from '../app/inline/completion'
import { AmazonQLspAuth, encryptionKey, notificationTypes } from './auth'
import {
    CreateFilesParams,
    DeleteFilesParams,
    DidChangeWorkspaceFoldersParams,
    GetConfigurationFromServerParams,
    RenameFilesParams,
    ResponseMessage,
    WorkspaceFolder,
    ConnectionMetadata,
} from '@aws/language-server-runtimes/protocol'
import {
    AuthUtil,
    CodeWhispererSettings,
    getSelectedCustomization,
    TelemetryHelper,
} from 'aws-core-vscode/codewhisperer'
import {
    Settings,
    createServerOptions,
    globals,
    Experiments,
    Commands,
    oneSecond,
    validateNodeExe,
    getLogger,
    undefinedIfEmpty,
    getOptOutPreference,
    isAmazonLinux2,
    getClientId,
    extensionVersion,
    isSageMaker,
    DevSettings,
} from 'aws-core-vscode/shared'
import { processUtils } from 'aws-core-vscode/shared'
import { activate } from './chat/activation'
import { AmazonQResourcePaths } from './lspInstaller'
import { ConfigSection, isValidConfigSection, pushConfigUpdate, toAmazonQLSPLogLevel } from './config'
import { activate as activateInlineChat } from '../inlineChat/activation'
import { telemetry } from 'aws-core-vscode/telemetry'
import { SessionManager } from '../app/inline/sessionManager'
import { LineTracker } from '../app/inline/stateTracker/lineTracker'
import { InlineTutorialAnnotation } from '../app/inline/tutorials/inlineTutorialAnnotation'
import { InlineChatTutorialAnnotation } from '../app/inline/tutorials/inlineChatTutorialAnnotation'

const localize = nls.loadMessageBundle()
const logger = getLogger('amazonqLsp.lspClient')

export function hasGlibcPatch(): boolean {
    // Skip GLIBC patching for SageMaker environments
    if (isSageMaker()) {
        getLogger('amazonqLsp').info('SageMaker environment detected in hasGlibcPatch, skipping GLIBC patching')
        return false // Return false to ensure SageMaker doesn't try to use GLIBC patching
    }

    // Check for environment variables (for CDM)
    const glibcLinker = process.env.VSCODE_SERVER_CUSTOM_GLIBC_LINKER || ''
    const glibcPath = process.env.VSCODE_SERVER_CUSTOM_GLIBC_PATH || ''

    if (glibcLinker.length > 0 && glibcPath.length > 0) {
        getLogger('amazonqLsp').info('GLIBC patching environment variables detected')
        return true
    }

    // No environment variables, no patching needed
    return false
}

export async function startLanguageServer(
    extensionContext: vscode.ExtensionContext,
    resourcePaths: AmazonQResourcePaths
) {
    const toDispose = extensionContext.subscriptions

    const serverModule = resourcePaths.lsp

    const argv = [
        '--nolazy',
        '--preserve-symlinks',
        '--stdio',
        '--pre-init-encryption',
        '--set-credentials-encryption-key',
    ]

    const documentSelector = [{ scheme: 'file', language: '*' }]

    const clientId = 'amazonq'
    const traceServerEnabled = Settings.instance.isSet(`${clientId}.trace.server`)
    let executable: string[] = []
    // apply the GLIBC 2.28 path to node js runtime binary
    if (isSageMaker()) {
        // SageMaker doesn't need GLIBC patching
        getLogger('amazonqLsp').info('SageMaker environment detected, skipping GLIBC patching')
        executable = [resourcePaths.node]
    } else if (isAmazonLinux2() && hasGlibcPatch()) {
        // Use environment variables if available (for CDM)
        if (process.env.VSCODE_SERVER_CUSTOM_GLIBC_LINKER && process.env.VSCODE_SERVER_CUSTOM_GLIBC_PATH) {
            executable = [
                process.env.VSCODE_SERVER_CUSTOM_GLIBC_LINKER,
                '--library-path',
                process.env.VSCODE_SERVER_CUSTOM_GLIBC_PATH,
                resourcePaths.node,
            ]
            getLogger('amazonqLsp').info(`Patched node runtime with GLIBC using env vars to ${executable}`)
        } else {
            // No environment variables, use the node executable directly
            executable = [resourcePaths.node]
        }
    } else {
        executable = [resourcePaths.node]
    }

    const memoryWarnThreshold = 1024 * processUtils.oneMB
    const serverOptions = createServerOptions({
        encryptionKey,
        executable: executable,
        serverModule,
        execArgv: argv,
        warnThresholds: { memory: memoryWarnThreshold },
    })

    await validateNodeExe(executable, resourcePaths.lsp, argv, logger)

    const endpointOverride = DevSettings.instance.get('codewhispererService', {}).endpoint ?? undefined
    const textDocSection = {
        inlineEditSupport: Experiments.instance.get('amazonqLSPNEP', true),
    } as any

    if (endpointOverride) {
        textDocSection.endpointOverride = endpointOverride
    }

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        // Register the server for json documents
        documentSelector,
        middleware: {
            workspace: {
                /**
                 * Convert VSCode settings format to be compatible with flare's configs
                 */
                configuration: async (params, token, next) => {
                    const config = await next(params, token)
                    const section = params.items[0].section
                    if (!isValidConfigSection(section)) {
                        return config
                    }
                    return getConfigSection(section)
                },
            },
        },
        initializationOptions: {
            aws: {
                clientInfo: {
                    name: env.appName,
                    version: version,
                    extension: {
                        name: 'AmazonQ-For-VSCode',
                        version: extensionVersion,
                    },
                    clientId: getClientId(globals.globalState),
                },
                awsClientCapabilities: {
                    q: {
                        developerProfiles: true,
                        pinnedContextEnabled: true,
                        imageContextEnabled: true,
                        mcp: true,
                        shortcut: true,
                        reroute: true,
                        modelSelection: true,
                        workspaceFilePath: vscode.workspace.workspaceFile?.fsPath,
                        codeReviewInChat: false,
                    },
                    window: {
                        notifications: true,
                        showSaveFileDialog: true,
                        showLogs: isSageMaker() ? false : true,
                    },
                    textDocument: {
                        inlineCompletionWithReferences: textDocSection,
                    },
                },
                contextConfiguration: {
                    workspaceIdentifier: extensionContext.storageUri?.path,
                },
                logLevel: isSageMaker() ? 'debug' : toAmazonQLSPLogLevel(globals.logOutputChannel.logLevel),
            },
            credentials: {
                providesBearerToken: true,
                providesIam: isSageMaker(), // Enable IAM credentials for SageMaker environments
            },
        },
        /**
         * When the trace server is enabled it outputs a ton of log messages so:
         *   When trace server is enabled, logs go to a seperate "Amazon Q Language Server" output.
         *   Otherwise, logs go to the regular "Amazon Q Logs" channel.
         */
        ...(traceServerEnabled
            ? {}
            : {
                  outputChannel: globals.logOutputChannel,
              }),
    }

    const client = new LanguageClient(
        clientId,
        localize('amazonq.server.name', 'Amazon Q Language Server'),
        serverOptions,
        clientOptions
    )

    const disposable = client.start()
    toDispose.push(disposable)
    await client.onReady()

    // Set up connection metadata handler
    client.onRequest<ConnectionMetadata, Error>(notificationTypes.getConnectionMetadata.method, () => {
        // For IAM auth, provide a default startUrl
        if (process.env.USE_IAM_AUTH === 'true') {
            getLogger().info(
                `[SageMaker Debug] Connection metadata requested - returning hardcoded startUrl for IAM auth`
            )
            return {
                sso: {
                    // TODO P261194666 Replace with correct startUrl once identified
                    startUrl: 'https://amzn.awsapps.com/start', // Default for IAM auth
                },
            }
        }

        // For SSO auth, use the actual startUrl
        getLogger().info(
            `[SageMaker Debug] Connection metadata requested - returning actual startUrl for SSO auth: ${AuthUtil.instance.auth.startUrl}`
        )
        return {
            sso: {
                startUrl: AuthUtil.instance.auth.startUrl,
            },
        }
    })

    const auth = await initializeAuth(client)

    await onLanguageServerReady(extensionContext, auth, client, resourcePaths, toDispose)

    return client
}

async function initializeAuth(client: LanguageClient): Promise<AmazonQLspAuth> {
    const auth = new AmazonQLspAuth(client)
    await auth.refreshConnection(true)
    return auth
}

// jscpd:ignore-start
async function initializeLanguageServerConfiguration(client: LanguageClient, context: string = 'startup') {
    const logger = getLogger('amazonqLsp')

    if (AuthUtil.instance.isConnectionValid()) {
        logger.info(`[${context}] Initializing language server configuration`)
        // jscpd:ignore-end

        try {
            // Send profile configuration
            logger.debug(`[${context}] Sending profile configuration to language server`)
            await sendProfileToLsp(client)
            logger.debug(`[${context}] Profile configuration sent successfully`)

            // Send customization configuration
            logger.debug(`[${context}] Sending customization configuration to language server`)
            await pushConfigUpdate(client, {
                type: 'customization',
                customization: getSelectedCustomization(),
            })
            logger.debug(`[${context}] Customization configuration sent successfully`)

            logger.info(`[${context}] Language server configuration completed successfully`)
        } catch (error) {
            logger.error(`[${context}] Failed to initialize language server configuration: ${error}`)
            throw error
        }
    } else {
        logger.warn(
            `[${context}] Connection invalid, skipping language server configuration - this will cause authentication failures`
        )
        const activeConnection = AuthUtil.instance.auth.activeConnection
        const connectionState = activeConnection
            ? AuthUtil.instance.auth.getConnectionState(activeConnection)
            : 'no-connection'
        logger.warn(`[${context}] Connection state: ${connectionState}`)
    }
}

async function sendProfileToLsp(client: LanguageClient) {
    const logger = getLogger('amazonqLsp')
    const profileArn = AuthUtil.instance.regionProfileManager.activeRegionProfile?.arn

    logger.debug(`Sending profile to LSP: ${profileArn || 'undefined'}`)

    await pushConfigUpdate(client, {
        type: 'profile',
        profileArn: profileArn,
    })

    logger.debug(`Profile sent to LSP successfully`)
}

async function onLanguageServerReady(
    extensionContext: vscode.ExtensionContext,
    auth: AmazonQLspAuth,
    client: LanguageClient,
    resourcePaths: AmazonQResourcePaths,
    toDispose: vscode.Disposable[]
) {
    const sessionManager = new SessionManager()

    // keeps track of the line changes
    const lineTracker = new LineTracker()

    // tutorial for inline suggestions
    const inlineTutorialAnnotation = new InlineTutorialAnnotation(lineTracker, sessionManager)

    // tutorial for inline chat
    const inlineChatTutorialAnnotation = new InlineChatTutorialAnnotation(inlineTutorialAnnotation)

    const inlineManager = new InlineCompletionManager(client, sessionManager, lineTracker, inlineTutorialAnnotation)
    inlineManager.registerInlineCompletion()
    activateInlineChat(extensionContext, client, encryptionKey, inlineChatTutorialAnnotation)

    if (Experiments.instance.get('amazonqChatLSP', true)) {
        await activate(client, encryptionKey, resourcePaths.ui)
    }

    const refreshInterval = auth.startTokenRefreshInterval(10 * oneSecond)

    // We manually push the cached values the first time since event handlers, which should push, may not have been setup yet.
    // Execution order is weird and should be fixed in the flare implementation.
    // TODO: Revisit if we need this if we setup the event handlers properly
    await initializeLanguageServerConfiguration(client, 'startup')

    toDispose.push(
        inlineManager,
        Commands.register('aws.amazonq.showPrev', async () => {
            await sessionManager.maybeRefreshSessionUx()
            await vscode.commands.executeCommand('editor.action.inlineSuggest.showPrevious')
            sessionManager.onPrevSuggestion()
        }),
        Commands.register('aws.amazonq.showNext', async () => {
            await sessionManager.maybeRefreshSessionUx()
            await vscode.commands.executeCommand('editor.action.inlineSuggest.showNext')
            sessionManager.onNextSuggestion()
        }),
        // this is a workaround since handleDidShowCompletionItem is not public API
        Commands.register('aws.amazonq.checkInlineSuggestionVisibility', async () => {
            sessionManager.checkInlineSuggestionVisibility()
        }),
        Commands.register({ id: 'aws.amazonq.invokeInlineCompletion', autoconnect: true }, async () => {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')
        }),
        Commands.register('aws.amazonq.refreshAnnotation', async (forceProceed: boolean) => {
            telemetry.record({
                traceId: TelemetryHelper.instance.traceId,
            })

            const editor = vscode.window.activeTextEditor
            if (editor) {
                if (forceProceed) {
                    await inlineTutorialAnnotation.refresh(editor, 'codewhisperer', true)
                } else {
                    await inlineTutorialAnnotation.refresh(editor, 'codewhisperer')
                }
            }
        }),
        Commands.register('aws.amazonq.dismissTutorial', async () => {
            const editor = vscode.window.activeTextEditor
            if (editor) {
                inlineTutorialAnnotation.clear()
                try {
                    telemetry.ui_click.emit({ elementId: `dismiss_${inlineTutorialAnnotation.currentState.id}` })
                } catch (_) {}
                await inlineTutorialAnnotation.dismissTutorial()
                getLogger().debug(`codewhisperer: user dismiss tutorial.`)
            }
        }),
        vscode.workspace.onDidCloseTextDocument(async () => {
            await vscode.commands.executeCommand('aws.amazonq.rejectCodeSuggestion')
        }),
        AuthUtil.instance.auth.onDidChangeActiveConnection(async () => {
            await auth.refreshConnection()
        }),
        AuthUtil.instance.auth.onDidDeleteConnection(async () => {
            client.sendNotification(notificationTypes.deleteBearerToken.method)
        }),
        AuthUtil.instance.regionProfileManager.onDidChangeRegionProfile(() => sendProfileToLsp(client)),
        vscode.commands.registerCommand('aws.amazonq.getWorkspaceId', async () => {
            const requestType = new RequestType<GetConfigurationFromServerParams, ResponseMessage, Error>(
                'aws/getConfigurationFromServer'
            )
            const workspaceIdResp = await client.sendRequest(requestType.method, {
                section: 'aws.q.workspaceContext',
            })
            return workspaceIdResp
        }),
        vscode.workspace.onDidCreateFiles((e) => {
            client.sendNotification('workspace/didCreateFiles', {
                files: e.files.map((it) => {
                    return { uri: it.fsPath }
                }),
            } as CreateFilesParams)
        }),
        vscode.workspace.onDidDeleteFiles((e) => {
            client.sendNotification('workspace/didDeleteFiles', {
                files: e.files.map((it) => {
                    return { uri: it.fsPath }
                }),
            } as DeleteFilesParams)
        }),
        vscode.workspace.onDidRenameFiles((e) => {
            client.sendNotification('workspace/didRenameFiles', {
                files: e.files.map((it) => {
                    return { oldUri: it.oldUri.fsPath, newUri: it.newUri.fsPath }
                }),
            } as RenameFilesParams)
        }),
        vscode.workspace.onDidChangeWorkspaceFolders((e) => {
            client.sendNotification('workspace/didChangeWorkspaceFolder', {
                event: {
                    added: e.added.map((it) => {
                        return {
                            name: it.name,
                            uri: it.uri.fsPath,
                        } as WorkspaceFolder
                    }),
                    removed: e.removed.map((it) => {
                        return {
                            name: it.name,
                            uri: it.uri.fsPath,
                        } as WorkspaceFolder
                    }),
                },
            } as DidChangeWorkspaceFoldersParams)
        }),
        { dispose: () => clearInterval(refreshInterval) },
        // Set this inside onReady so that it only triggers on subsequent language server starts (not the first)
        onServerRestartHandler(client, auth)
    )
}

/**
 * When the server restarts (likely due to a crash, then the LanguageClient automatically starts it again)
 * we need to run some server intialization again.
 */
function onServerRestartHandler(client: LanguageClient, auth: AmazonQLspAuth) {
    return client.onDidChangeState(async (e) => {
        // Ensure we are in a "restart" state
        if (!(e.oldState === State.Starting && e.newState === State.Running)) {
            return
        }

        // Emit telemetry that a crash was detected.
        // It is not guaranteed to 100% be a crash since somehow the server may have been intentionally restarted,
        // but most of the time it probably will have been due to a crash.
        // TODO: Port this metric override to common definitions
        telemetry.languageServer_crash.emit({ id: 'AmazonQ' })

        const logger = getLogger('amazonqLsp')
        logger.info('[crash-recovery] Language server crash detected, reinitializing authentication')

        try {
            // Send bearer token
            logger.debug('[crash-recovery] Refreshing connection and sending bearer token')
            await auth.refreshConnection(true)
            logger.debug('[crash-recovery] Bearer token sent successfully')

            // Send profile and customization configuration
            await initializeLanguageServerConfiguration(client, 'crash-recovery')
            logger.info('[crash-recovery] Authentication reinitialized successfully')
        } catch (error) {
            logger.error(`[crash-recovery] Failed to reinitialize after crash: ${error}`)
        }
    })
}

function getConfigSection(section: ConfigSection) {
    getLogger('amazonqLsp').debug('Fetching config section %s for language server', section)
    switch (section) {
        case 'aws.q':
            /**
             * IMPORTANT: This object is parsed by the following code in the language server, **so
             * it must match that expected shape**.
             * https://github.com/aws/language-servers/blob/1d2ca018f2248106690438b860d40a7ee67ac728/server/aws-lsp-codewhisperer/src/shared/amazonQServiceManager/configurationUtils.ts#L114
             */
            return [
                {
                    customization: undefinedIfEmpty(getSelectedCustomization().arn),
                    optOutTelemetry: getOptOutPreference() === 'OPTOUT',
                    projectContext: {
                        enableLocalIndexing: CodeWhispererSettings.instance.isLocalIndexEnabled(),
                        enableGpuAcceleration: CodeWhispererSettings.instance.isLocalIndexGPUEnabled(),
                        indexWorkerThreads: CodeWhispererSettings.instance.getIndexWorkerThreads(),
                        localIndexing: {
                            ignoreFilePatterns: CodeWhispererSettings.instance.getIndexIgnoreFilePatterns(),
                            maxFileSizeMB: CodeWhispererSettings.instance.getMaxIndexFileSize(),
                            maxIndexSizeMB: CodeWhispererSettings.instance.getMaxIndexSize(),
                            indexCacheDirPath: CodeWhispererSettings.instance.getIndexCacheDirPath(),
                        },
                    },
                },
            ]
        case 'aws.codeWhisperer':
            return [
                {
                    includeSuggestionsWithCodeReferences:
                        CodeWhispererSettings.instance.isSuggestionsWithCodeReferencesEnabled(),
                    shareCodeWhispererContentWithAWS: !CodeWhispererSettings.instance.isOptoutEnabled(),
                    includeImportsWithSuggestions: CodeWhispererSettings.instance.isImportRecommendationEnabled(),
                    sendUserWrittenCodeMetrics: true,
                },
            ]
        case 'aws.logLevel':
            return [toAmazonQLSPLogLevel(globals.logOutputChannel.logLevel)]
    }
}
