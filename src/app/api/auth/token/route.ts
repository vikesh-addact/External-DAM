import { NextRequest, NextResponse } from 'next/server';

const SITECORE_AUTH_URL = 'https://auth.sitecorecloud.io/oauth/token';
const DEFAULT_AUDIENCE = 'https://api.sitecorecloud.io';

interface TokenRequestBody {
    clientId: string;
    clientSecret: string;
    audience?: string;
}

interface TokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
}

export async function POST(request: NextRequest) {
    try {
        const body: TokenRequestBody = await request.json();

        if (!body.clientId || !body.clientSecret) {
            return NextResponse.json(
                { error: 'client_id and client_secret are required' },
                { status: 400 }
            );
        }

        const params = new URLSearchParams();
        params.append('client_id', body.clientId);
        params.append('client_secret', body.clientSecret);
        params.append('grant_type', 'client_credentials');
        params.append('audience', body.audience || DEFAULT_AUDIENCE);

        const response = await fetch(SITECORE_AUTH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Sitecore auth failed: ${response.status} ${errorText}`);

            return NextResponse.json(
                {
                    error: 'Authentication failed',
                    status: response.status,
                    detail: response.status === 401
                        ? 'Invalid client_id or client_secret'
                        : `Auth server returned ${response.status}`,
                },
                { status: response.status === 401 ? 401 : 502 }
            );
        }

        const data: TokenResponse = await response.json();

        return NextResponse.json({
            access_token: data.access_token,
            expires_in: data.expires_in,
            token_type: data.token_type,
            scope: data.scope,
        });
    } catch (error) {
        console.error('Token exchange error:', error);
        return NextResponse.json(
            { error: 'Internal server error during token exchange' },
            { status: 500 }
        );
    }
}
