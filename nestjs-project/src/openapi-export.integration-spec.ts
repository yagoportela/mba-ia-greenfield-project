import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('phase 03 video endpoints', () => {
    const VIDEO_ENDPOINTS = [
      { path: '/videos', method: 'post' },
      { path: '/videos/{id}', method: 'get' },
      { path: '/videos/{id}/upload-parts', method: 'post' },
      { path: '/videos/{id}/upload-complete', method: 'post' },
      { path: '/videos/{publicId}/playback', method: 'get' },
      { path: '/videos/{publicId}/download', method: 'get' },
    ];

    interface OpenApiOperation {
      summary?: string;
      security?: Array<Record<string, unknown>>;
      responses?: Record<
        string,
        {
          content?: {
            'application/json'?: {
              schema?: { $ref?: string };
            };
          };
        }
      >;
    }

    type PathsMap = Record<string, Record<string, OpenApiOperation>>;

    function getOperation(
      pathsMap: PathsMap,
      path: string,
      method: string,
    ): OpenApiOperation {
      const operation = pathsMap[path]?.[method];
      expect(operation).toBeDefined();
      return operation;
    }

    function expectErrorEnvelope(
      operation: OpenApiOperation,
      status: string,
    ): void {
      const response = operation.responses?.[status];
      expect(response).toBeDefined();
      expect(response?.content?.['application/json']?.schema?.$ref).toBe(
        '#/components/schemas/ApiErrorEnvelope',
      );
    }

    it('exports all six phase 03 paths with a non-empty summary', () => {
      const pathsMap = document.paths as PathsMap;

      for (const { path, method } of VIDEO_ENDPOINTS) {
        const operation = getOperation(pathsMap, path, method);
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    });

    it('documents the video endpoints as protected with access-token', () => {
      const pathsMap = document.paths as PathsMap;

      for (const { path, method } of VIDEO_ENDPOINTS) {
        const operation = getOperation(pathsMap, path, method);
        const security = operation.security as Array<Record<string, unknown>>;
        expect(security).toBeDefined();
        expect(security.some((req) => 'access-token' in req)).toBe(true);
      }
    });

    it('references ApiErrorEnvelope on the documented error statuses', () => {
      const pathsMap = document.paths as PathsMap;

      const expectedErrors: Record<string, string[]> = {
        '/videos': ['400', '401', '413', '415', '502'],
        '/videos/{id}': ['401', '403', '404', '502'],
        '/videos/{id}/upload-parts': ['400', '401', '403', '404', '409', '502'],
        '/videos/{id}/upload-complete': [
          '400',
          '401',
          '403',
          '404',
          '409',
          '413',
          '415',
          '502',
        ],
        '/videos/{publicId}/playback': ['401', '403', '404', '409', '502'],
        '/videos/{publicId}/download': ['401', '403', '404', '409', '502'],
      };

      for (const { path, method } of VIDEO_ENDPOINTS) {
        const operation = getOperation(pathsMap, path, method);
        for (const status of expectedErrors[path]) {
          expectErrorEnvelope(operation, status);
        }
      }
    });

    it('documents the upload-complete success status as 202', () => {
      const pathsMap = document.paths as PathsMap;
      const operation = getOperation(
        pathsMap,
        '/videos/{id}/upload-complete',
        'post',
      );

      expect(operation.responses?.['202']).toBeDefined();
      expect(operation.responses?.['201']).toBeUndefined();
    });
  });
});
