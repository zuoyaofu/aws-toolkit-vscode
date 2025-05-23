/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path'
import http from 'http'
import { getLogger } from '../../shared/logger/logger'
import { ToolkitError } from '../../shared/errors'
import { Socket } from 'net'
import globals from '../../shared/extensionGlobals'
import { Result } from '../../shared/utilities/result'
import fs from '../../shared/fs/fs'
import { CancellationError } from '../../shared/utilities/timeoutUtils'

export class MissingPortError extends ToolkitError {
    constructor() {
        super('AuthSSOServer: missing auth server port', { code: 'MissingPort' })
    }
}

export class MissingCodeError extends ToolkitError {
    constructor() {
        super('AuthSSOServer: missing code', { code: 'MissingCode' })
    }
}

export class MissingStateError extends ToolkitError {
    constructor() {
        super('AuthSSOServer: missing state', { code: 'MissingState' })
    }
}

export class InvalidStateError extends ToolkitError {
    constructor() {
        super('AuthSSOServer: invalid state', { code: 'InvalidState' })
    }
}

export class AuthError extends ToolkitError {
    constructor(error: string, errorDescription: string) {
        super(`AuthSSOServer: ${error}: ${errorDescription}`, { code: 'AuthRedirectError' })
    }
}

/**
 * Server responsible for taking redirect requests from auth and redirecting them
 * back to VSCode
 */
export class AuthSSOServer {
    // Last initialized instance of the Auth Server
    static #lastInstance: AuthSSOServer | undefined
    public static get lastInstance() {
        return AuthSSOServer.#lastInstance
    }

    private baseUrl = `http://127.0.0.1`
    private oauthCallback = '/oauth/callback'
    private authenticationFlowTimeoutInMs = 600000
    private authenticationWarningTimeoutInMs = 60000

    private readonly authenticationPromise: Promise<Result<string>>
    private deferred: { resolve: (result: Result<string>) => void } | undefined
    private server: http.Server
    private connections: Socket[]

    private _closed: boolean = false

    private constructor(private readonly state: string) {
        this.authenticationPromise = new Promise<Result<string>>((resolve) => {
            this.deferred = { resolve }
        })

        this.connections = []

        this.server = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Methods', 'GET')

            if (!req.url) {
                return
            }

            const url = new URL(req.url, this.baseUrl)
            switch (url.pathname) {
                case this.oauthCallback: {
                    this.handleAuthentication(url.searchParams, res)
                    break
                }
                default: {
                    if (url.pathname.startsWith('/resources')) {
                        const iconPath = path.join(globals.context.extensionUri.fsPath, url.pathname)
                        await this.loadResource(res, iconPath)
                        break
                    }
                    const resourcePath = path.join(
                        globals.context.extensionUri.fsPath,
                        'dist/src/auth/sso/vue',
                        url.pathname
                    )
                    await this.loadResource(res, resourcePath)
                    break
                }
            }
        })

        this.server.on('connection', (connection) => {
            this.connections.push(connection)
        })
    }

    public static init(state: string) {
        const lastInstance = AuthSSOServer.#lastInstance
        if (lastInstance !== undefined && !lastInstance.closed) {
            lastInstance
                .close()!
                .catch((err) =>
                    getLogger().error('Failed to close already existing auth sever in AuthSSOServer.init(): %s', err)
                )
        }

        getLogger().debug('AuthSSOServer: Initialized new auth server.')
        const instance = new AuthSSOServer(state)
        AuthSSOServer.#lastInstance = instance
        return instance
    }

    start() {
        if (this.server.listening) {
            throw new ToolkitError('AuthSSOServer: Server already started')
        }

        return new Promise<void>((resolve, reject) => {
            this.server.on('close', () => {
                reject(new ToolkitError('AuthSSOServer: Server has closed'))
            })

            this.server.on('error', (error) => {
                reject(new ToolkitError(`AuthSSOServer: Server failed: ${error}`))
            })

            this.server.on('listening', () => {
                if (!this.server.address()) {
                    reject(new MissingPortError())
                }

                resolve()
            })

            this.server.listen(0, '127.0.0.1')
        })
    }

    close() {
        return new Promise<void>((resolve, reject) => {
            if (this._closed) {
                resolve()
                return
            }

            if (!this.server.listening) {
                reject(new ToolkitError('AuthSSOServer: Server not started'))
            }

            getLogger().debug('AuthSSOServer: Attempting to close server.')

            for (const connection of this.connections) {
                connection.destroy()
            }

            this.server.close((err) => {
                if (err) {
                    reject(err)
                }
                this._closed = true
                getLogger().debug('AuthSSOServer: Server closed successfully.')
                resolve()
            })
        })
    }

    public get redirectUri(): string {
        return `${this.baseLocation}${this.oauthCallback}`
    }

    private get baseLocation(): string {
        return `${this.baseUrl}:${this.getPort()}`
    }

    public get closed() {
        return this._closed
    }

    public getAddress() {
        return this.server.address()
    }

    private getPort(): number {
        const addr = this.getAddress()
        if (addr instanceof Object) {
            return addr.port
        } else if (typeof addr === 'string') {
            return parseInt(addr)
        } else {
            throw new MissingPortError()
        }
    }

    private redirect(res: http.ServerResponse, error?: string) {
        let redirectUrl = `${this.baseLocation}/index.html`
        if (error) {
            redirectUrl += `?${new URLSearchParams({ error }).toString()}`
        }

        res.setHeader('Location', redirectUrl)
        res.writeHead(302)
        res.end()
    }

    private async loadResource(res: http.ServerResponse, resourcePath: string) {
        try {
            const file = await fs.readFileBytes(resourcePath)
            res.writeHead(200)
            res.end(file)
        } catch (e) {
            getLogger().error(`Unable to find ${resourcePath}`)
            res.writeHead(404)
            res.end()
        }
    }

    private handleAuthentication(params: URLSearchParams, res: http.ServerResponse) {
        const error = params.get('error')
        const errorDescription = params.get('error_description')
        if (error && errorDescription) {
            this.handleRequestRejection(res, new AuthError(error, errorDescription))
            return
        }

        const code = params.get('code')
        if (!code) {
            this.handleRequestRejection(res, new MissingCodeError())
            return
        }

        const state = params.get('state')
        if (!state) {
            this.handleRequestRejection(res, new MissingStateError())
            return
        }

        if (state !== this.state) {
            this.handleRequestRejection(res, new InvalidStateError())
            return
        }

        this.deferred?.resolve(Result.ok(code))

        this.redirect(res)
    }

    private handleRequestRejection(res: http.ServerResponse, error: ToolkitError) {
        // Notify the user
        this.redirect(res, error.message)

        // Send the response back to the editor
        this.deferred?.resolve(Result.err(error))
    }

    public cancelCurrentFlow() {
        getLogger().debug('AuthSSOServer: Cancelling current login flow')
        this.deferred?.resolve(Result.err(new CancellationError('user')))
    }

    public waitForAuthorization(): Promise<Result<string>> {
        return Promise.race([
            this.authenticationPromise,
            new Promise<Result<string>>((_, reject) => {
                globals.clock.setTimeout(() => {
                    reject(
                        new ToolkitError('Timed-out waiting for browser login flow to complete', {
                            code: 'TimedOut',
                        })
                    )
                }, this.authenticationFlowTimeoutInMs)

                const warningTimeout = globals.clock.setTimeout(() => {
                    getLogger().warn('AuthSSOServer: Authentication is taking a long time')
                }, this.authenticationWarningTimeoutInMs)

                void this.authenticationPromise.finally(() => {
                    clearTimeout(warningTimeout)
                })
            }),
        ])
    }
}
