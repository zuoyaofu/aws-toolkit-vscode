/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../../shared/extensionGlobals'

import {
    AccountInfo,
    GetRoleCredentialsRequest,
    ListAccountRolesRequest,
    ListAccountsRequest,
    LogoutRequest,
    RoleInfo,
    SSO,
    SSOServiceException,
} from '@aws-sdk/client-sso'
import {
    AuthorizationPendingException,
    CreateTokenRequest,
    RegisterClientRequest,
    SSOOIDC,
    SSOOIDCClient,
    StartDeviceAuthorizationRequest,
} from '@aws-sdk/client-sso-oidc'
import { AsyncCollection } from '../../shared/utilities/asyncCollection'
import { pageableToCollection, partialClone } from '../../shared/utilities/collectionUtils'
import { assertHasProps, isNonNullable, RequiredProps, selectFrom } from '../../shared/utilities/tsUtils'
import { getLogger } from '../../shared/logger/logger'
import { SsoAccessTokenProvider } from './ssoAccessTokenProvider'
import { AwsClientResponseError, isClientFault } from '../../shared/errors'
import { DevSettings } from '../../shared/settings'
import { SdkError } from '@aws-sdk/types'
import { HttpRequest, HttpResponse } from '@smithy/protocol-http'
import { StandardRetryStrategy, defaultRetryDecider } from '@smithy/middleware-retry'
import { AuthenticationFlow } from './model'
import { toSnakeCase } from '../../shared/utilities/textUtilities'
import { getUserAgent, withTelemetryContext } from '../../shared/telemetry/util'
import { oneSecond } from '../../shared/datetime'

export class OidcClient {
    public constructor(
        private readonly client: SSOOIDC,
        private readonly clock: { Date: typeof Date }
    ) {}

    public async registerClient(request: RegisterClientRequest, startUrl: string, flow?: AuthenticationFlow) {
        const response = await this.client.registerClient(request)
        assertHasProps(response, 'clientId', 'clientSecret', 'clientSecretExpiresAt')

        return {
            scopes: request.scopes,
            clientId: response.clientId,
            clientSecret: response.clientSecret,
            expiresAt: new this.clock.Date(response.clientSecretExpiresAt * 1000),
            startUrl,
            ...(flow ? { flow } : {}),
        }
    }

    public async startDeviceAuthorization(request: StartDeviceAuthorizationRequest) {
        const response = await this.client.startDeviceAuthorization(request)
        assertHasProps(response, 'expiresIn', 'deviceCode', 'userCode', 'verificationUri')

        return {
            ...selectFrom(response, 'deviceCode', 'userCode', 'verificationUri'),
            expiresAt: new this.clock.Date(response.expiresIn * 1000 + this.clock.Date.now()),
            interval: response.interval ? response.interval * 1000 : undefined,
        }
    }

    public async authorize(request: {
        responseType: string
        clientId: string
        redirectUri: string
        scopes: string[]
        state: string
        codeChallenge: string
        codeChallengeMethod: string
    }) {
        // aws sdk doesn't convert to url params until right before you make the request, so we have to do
        // it manually ahead of time
        const params = toSnakeCase(request)
        const searchParams = new URLSearchParams(params).toString()
        const region = await this.client.config.region()
        return `https://oidc.${region}.amazonaws.com/authorize?${searchParams}`
    }

    public async createToken(request: CreateTokenRequest) {
        let response
        try {
            response = await this.client.createToken(request as CreateTokenRequest)
        } catch (err) {
            const newError = AwsClientResponseError.instanceIf(err)
            throw newError
        }
        assertHasProps(response, 'accessToken', 'expiresIn')

        return {
            ...selectFrom(response, 'accessToken', 'refreshToken', 'tokenType'),
            requestId: response.$metadata.requestId,
            expiresAt: new this.clock.Date(response.expiresIn * 1000 + this.clock.Date.now()),
        }
    }

    public static create(region: string) {
        const updatedRetryDecider = (err: SdkError) => {
            if (defaultRetryDecider(err)) {
                return true
            }

            // As part of SIM IDE-10703, there was an assumption that retrying on InvalidGrantException
            // may be useful. This may not be the case anymore and if more research is done, this may not be needed.
            // TODO: setup some telemetry to see if there are any successes on a subsequent retry for this case.
            return err.name === 'InvalidGrantException'
        }
        const client = new SSOOIDC({
            region,
            endpoint: DevSettings.instance.get('endpoints', {})['ssooidc'],
            retryStrategy: new StandardRetryStrategy(
                () => Promise.resolve(3), // Maximum number of retries
                { retryDecider: updatedRetryDecider }
            ),
            customUserAgent: getUserAgent({ includePlatform: true, includeClientId: true }),
            requestHandler: {
                // This field may have a bug: https://github.com/aws/aws-sdk-js-v3/issues/6271
                // If the bug is real but is fixed, then we can probably remove this field and just have no timeout by default
                //
                // Also, we bump this higher due to ticket V1761315147, so that SSO does not timeout
                requestTimeout: oneSecond * 12,
            },
        })

        addLoggingMiddleware(client)
        return new this(client, globals.clock)
    }
}

type OmittedProps = 'accessToken' | 'nextToken'
type ExtractOverload<T, U> = T extends {
    (...args: infer P1): infer R1
    (...args: infer P2): infer R2
    (...args: infer P3): infer R3
}
    ? (this: U, ...args: P1) => R1
    : never

// Removes all methods that use callbacks instead of promises
type PromisifyClient<T> = {
    [P in keyof T]: T[P] extends (...args: any[]) => any ? ExtractOverload<T[P], PromisifyClient<T>> : T[P]
}

const ssoClientClassName = 'SsoClient'

export class SsoClient {
    public get region() {
        const region = this.client.config.region

        return typeof region === 'string' ? (region as string) : undefined
    }

    public constructor(
        private readonly client: PromisifyClient<SSO>,
        private readonly provider: SsoAccessTokenProvider
    ) {}

    @withTelemetryContext({ name: 'listAccounts', class: ssoClientClassName })
    public listAccounts(
        request: Omit<ListAccountsRequest, OmittedProps> = {}
    ): AsyncCollection<RequiredProps<AccountInfo, 'accountId'>[]> {
        const requester = (request: Omit<ListAccountsRequest, 'accessToken'>) =>
            this.call(this.client.listAccounts, request)
        const collection = pageableToCollection(requester, request, 'nextToken', 'accountList')

        return collection
            .filter(isNonNullable)
            .map((accounts) => accounts.map((a) => (assertHasProps(a, 'accountId'), a)))
    }

    @withTelemetryContext({ name: 'listAccountRoles', class: ssoClientClassName })
    public listAccountRoles(
        request: Omit<ListAccountRolesRequest, OmittedProps>
    ): AsyncCollection<Required<RoleInfo>[]> {
        const requester = (request: Omit<ListAccountRolesRequest, 'accessToken'>) =>
            this.call(this.client.listAccountRoles, request)
        const collection = pageableToCollection(requester, request, 'nextToken', 'roleList')

        return collection
            .filter(isNonNullable)
            .map((roles) => roles.map((r) => (assertHasProps(r, 'roleName', 'accountId'), r)))
    }

    @withTelemetryContext({ name: 'getRoleCredentials', class: ssoClientClassName })
    public async getRoleCredentials(request: Omit<GetRoleCredentialsRequest, OmittedProps>) {
        const response = await this.call(this.client.getRoleCredentials, request)

        assertHasProps(response, 'roleCredentials')
        assertHasProps(response.roleCredentials, 'accessKeyId', 'secretAccessKey')

        const expiration = response.roleCredentials.expiration

        return {
            ...response.roleCredentials,
            expiration: expiration ? new globals.clock.Date(expiration) : undefined,
        }
    }

    @withTelemetryContext({ name: 'logout', class: ssoClientClassName })
    public async logout(request: Omit<LogoutRequest, OmittedProps> = {}) {
        await this.call(this.client.logout, request)
    }

    private call<T extends { accessToken: string | undefined }, U>(
        method: (this: typeof this.client, request: T) => Promise<U>,
        request: Omit<T, 'accessToken'>
    ): Promise<U> {
        const requester = async (req: T) => {
            const token = await this.provider.getToken()
            assertHasProps(token, 'accessToken')

            try {
                return await method.call(this.client, { ...req, accessToken: token.accessToken })
            } catch (error) {
                await this.handleError(error)
                throw error
            }
        }

        return requester(request as T)
    }

    @withTelemetryContext({ name: 'handleError', class: ssoClientClassName })
    private async handleError(error: unknown): Promise<never> {
        if (error instanceof SSOServiceException && isClientFault(error) && error.name !== 'ForbiddenException') {
            getLogger().warn(`credentials (sso): invalidating stored token: ${error.message}`)
            await this.provider.invalidate(`ssoClient:${error.name}`)
        }

        throw error
    }

    public static create(region: string, provider: SsoAccessTokenProvider) {
        return new this(
            new SSO({
                region,
                endpoint: DevSettings.instance.get('endpoints', {})['sso'],
                customUserAgent: getUserAgent({ includePlatform: true, includeClientId: true }),
            }),
            provider
        )
    }
}

function addLoggingMiddleware(client: SSOOIDCClient) {
    client.middlewareStack.add(
        (next, context) => (args) => {
            if (HttpRequest.isInstance(args.request)) {
                const { hostname, path } = args.request
                const input = partialClone(
                    // TODO: Fix
                    args.input as unknown as Record<string, unknown>,
                    3,
                    ['clientSecret', 'accessToken', 'refreshToken'],
                    { replacement: '[omitted]' }
                )
                getLogger().debug('API request (%s %s): %O', hostname, path, input)
            }
            return next(args)
        },
        { step: 'finalizeRequest' }
    )

    client.middlewareStack.add(
        (next, context) => async (args) => {
            if (!HttpRequest.isInstance(args.request)) {
                return next(args)
            }

            const { hostname, path } = args.request
            const result = await next(args).catch((e) => {
                if (e instanceof Error && !(e instanceof AuthorizationPendingException)) {
                    const err = { ...e }
                    delete err['stack']
                    getLogger().error('API response (%s %s): %O', hostname, path, err)
                }
                throw e
            })
            if (HttpResponse.isInstance(result.response)) {
                const output = partialClone(
                    // TODO: Fix
                    result.output as unknown as Record<string, unknown>,
                    3,
                    ['clientSecret', 'accessToken', 'refreshToken'],
                    { replacement: '[omitted]' }
                )
                getLogger().debug('API response (%s %s): %O', hostname, path, output)
            }

            return result
        },
        { step: 'deserialize' }
    )
}
