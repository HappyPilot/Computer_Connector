export function withDeviceRoutingSchema(inputSchema, deviceSchema) {
  const schema = inputSchema && typeof inputSchema === 'object'
    ? structuredClone(inputSchema)
    : { type: 'object', properties: {} };
  schema.type = 'object';
  schema.properties = {
    ...(schema.properties || {}),
    deviceId: structuredClone(deviceSchema),
    approval_id: {
      type: 'string',
      format: 'uuid',
      pattern: '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
      description: 'Optional WCM timed-grant approval ID. In timed mode, omit it to create a new independent approval request; pass an active ID to reuse that exact grant.',
    },
  };
  schema.required = Array.from(new Set([
    ...(schema.required || []),
    'deviceId',
  ]));
  return schema;
}

export function stripDeviceRoutingArguments(args) {
  const forwarded = { ...(args || {}) };
  delete forwarded.deviceId;
  delete forwarded.approval_id;
  return forwarded;
}
