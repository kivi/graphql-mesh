import { GetMeshSourceOptions, MeshHandler, YamlConfig } from '@graphql-mesh/types';
import { JSONSchemaVisitor, getFileName } from './json-schema-visitor';
import urlJoin from 'url-join';
import { readFileOrUrlWithCache, stringInterpolator, parseInterpolationStrings, isUrl } from '@graphql-mesh/utils';
import AggregateError from 'aggregate-error';
import { fetchache, Request, KeyValueCache } from 'fetchache';
import { JSONSchemaDefinition } from './json-schema-types';
import { SchemaComposer } from 'graphql-compose';
import { pathExists, writeJSON } from 'fs-extra';
import toJsonSchema from 'to-json-schema';
import {
  GraphQLJSON,
  GraphQLVoid,
  GraphQLDate,
  GraphQLDateTime,
  GraphQLTime,
  // GraphQLTimestamp,
  GraphQLPhoneNumber,
  GraphQLURL,
  GraphQLEmailAddress,
  GraphQLIPv4,
  GraphQLIPv6,
} from 'graphql-scalars';

export default class JsonSchemaHandler implements MeshHandler {
  private config: YamlConfig.JsonSchemaHandler;
  private cache: KeyValueCache;
  constructor({ config, cache }: GetMeshSourceOptions<YamlConfig.JsonSchemaHandler>) {
    this.config = config;
    this.cache = cache;
  }

  async getMeshSource() {
    const schemaComposer = new SchemaComposer();

    schemaComposer.add(GraphQLJSON);
    schemaComposer.add(GraphQLVoid);
    schemaComposer.add(GraphQLDateTime);
    schemaComposer.add(GraphQLDate);
    schemaComposer.add(GraphQLTime);
    // schemaComposer.add(GraphQLTimestamp);
    schemaComposer.add(GraphQLPhoneNumber);
    schemaComposer.add(GraphQLURL);
    schemaComposer.add(GraphQLEmailAddress);
    schemaComposer.add(GraphQLIPv4);
    schemaComposer.add(GraphQLIPv6);

    const externalFileCache = new Map<string, any>();
    const inputSchemaVisitor = new JSONSchemaVisitor(schemaComposer, true, externalFileCache);
    const outputSchemaVisitor = new JSONSchemaVisitor(schemaComposer, false, externalFileCache);

    const contextVariables: string[] = [];

    await Promise.all(
      this.config.operations?.map(async operationConfig => {
        let [requestSchema, responseSchema] = await Promise.all([
          operationConfig.requestSample &&
            this.generateJsonSchemaFromSample({
              samplePath: operationConfig.requestSample,
              schemaPath: operationConfig.requestSchema,
            }),
          operationConfig.responseSample &&
            this.generateJsonSchemaFromSample({
              samplePath: operationConfig.responseSample,
              schemaPath: operationConfig.responseSchema,
            }),
        ]);
        [requestSchema, responseSchema] = await Promise.all([
          requestSchema ||
            (operationConfig.requestSchema &&
              readFileOrUrlWithCache(operationConfig.requestSchema, this.cache, {
                headers: this.config.schemaHeaders,
              })),
          responseSchema ||
            (operationConfig.responseSchema &&
              readFileOrUrlWithCache(operationConfig.responseSchema, this.cache, {
                headers: this.config.schemaHeaders,
              })),
        ]);
        operationConfig.method = operationConfig.method || (operationConfig.type === 'Mutation' ? 'POST' : 'GET');
        operationConfig.type = operationConfig.type || (operationConfig.method === 'GET' ? 'Query' : 'Mutation');
        const destination = operationConfig.type;
        const basedFilePath = operationConfig.responseSchema || operationConfig.responseSample;
        externalFileCache.set(basedFilePath, responseSchema);
        const responseFileName = getFileName(basedFilePath);
        const type = outputSchemaVisitor.visit(
          responseSchema as JSONSchemaDefinition,
          'Response',
          responseFileName,
          basedFilePath
        );

        const { args, contextVariables: specificContextVariables } = parseInterpolationStrings([
          ...Object.values(this.config.operationHeaders || {}),
          ...Object.values(operationConfig.headers || {}),
          operationConfig.path,
        ]);

        contextVariables.push(...specificContextVariables);

        if (requestSchema) {
          const basedFilePath = operationConfig.requestSchema || operationConfig.requestSample;
          externalFileCache.set(basedFilePath, requestSchema);
          const requestFileName = getFileName(basedFilePath);
          args.input = {
            type: inputSchemaVisitor.visit(
              requestSchema as JSONSchemaDefinition,
              'Request',
              requestFileName,
              basedFilePath
            ) as any,
          };
        }

        schemaComposer[destination].addFields({
          [operationConfig.field]: {
            description:
              operationConfig.description ||
              responseSchema.description ||
              `${operationConfig.method} ${operationConfig.path}`,
            type,
            args,
            resolve: async (root, args, context, info) => {
              const interpolationData = { root, args, context, info };
              const interpolatedPath = stringInterpolator.parse(operationConfig.path, interpolationData);
              const fullPath = urlJoin(this.config.baseUrl, interpolatedPath);
              const method = operationConfig.method;
              const headers = {
                ...this.config.operationHeaders,
                ...operationConfig?.headers,
              };
              for (const headerName in headers) {
                headers[headerName] = stringInterpolator.parse(headers[headerName], interpolationData);
              }
              const requestInit: RequestInit = {
                method,
                headers,
              };
              const urlObj = new URL(fullPath);
              const input = args.input;
              if (input) {
                switch (method) {
                  case 'GET':
                  case 'DELETE': {
                    const newSearchParams = new URLSearchParams(input);
                    newSearchParams.forEach((value, key) => {
                      urlObj.searchParams.set(key, value);
                    });
                    break;
                  }
                  case 'POST':
                  case 'PUT': {
                    requestInit.body = JSON.stringify(input);
                    break;
                  }
                  default:
                    throw new Error(`Unknown method ${operationConfig.method}`);
                }
              }
              const request = new Request(urlObj.toString(), requestInit);
              const response = await fetchache(request, this.cache);
              const responseText = await response.text();
              let responseJson: any;
              try {
                responseJson = JSON.parse(responseText);
              } catch (e) {
                throw responseText;
              }
              if (responseJson.errors) {
                throw new AggregateError(responseJson.errors);
              }
              if (responseJson._errors) {
                throw new AggregateError(responseJson._errors);
              }
              if (responseJson.error) {
                throw responseJson.error;
              }
              return responseJson;
            },
          },
        });
      }) || []
    );

    const schema = schemaComposer.buildSchema();

    return {
      schema,
      contextVariables,
    };
  }

  private async generateJsonSchemaFromSample({ samplePath, schemaPath }: { samplePath: string; schemaPath?: string }) {
    if (!schemaPath || (!isUrl(schemaPath) && !(await pathExists(schemaPath)))) {
      const sample = await readFileOrUrlWithCache(samplePath, this.cache);
      const schema = toJsonSchema(sample, {
        required: false,
        objects: {
          additionalProperties: false,
        },
        strings: {
          detectFormat: true,
        },
        arrays: {
          mode: 'first',
        },
      });
      if (schemaPath) {
        await writeJSON(schemaPath, schema);
      }
      return schema;
    }
    return null;
  }
}
