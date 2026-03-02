import {
  DataProvider,
  GetListParams,
  GetOneParams,
  GetManyParams,
  GetManyReferenceParams,
  CreateParams,
  UpdateParams,
  UpdateManyParams,
  DeleteParams,
  DeleteManyParams,
  RaRecord,
} from 'react-admin';
import { axiosClient } from './axiosClient';

// Resource → base API path
const resourcePath: Record<string, string> = {
  agents:            '/agents',
  campaigns:         '/campaigns',
  prompts:           '/prompts',
  'knowledge-bases': '/knowledge-bases',
  dnc:               '/dnc',
  dispositions:      '/campaigns',  // + /:campaignId/dispositions
  lists:             '/campaigns',  // + /:campaignId/lists
};

// Response list-key per resource (snake_case from server)
const listKey: Record<string, string> = {
  agents:            'agents',
  campaigns:         'campaigns',
  prompts:           'prompts',
  'knowledge-bases': 'knowledge_bases',
  dnc:               'dnc',
  dispositions:      'dispositions',
  lists:             'lists',
};

// Single-item response key
const singleKey: Record<string, string> = {
  agents:            'agent',
  campaigns:         'campaign',
  prompts:           'prompt',
  'knowledge-bases': 'knowledge_base',
  dnc:               'dnc',
  dispositions:      'disposition',
  lists:             'list',
};

type Meta = Record<string, unknown>;

function buildUrl(resource: string, meta: Meta = {}): string {
  if (resource === 'dispositions' && meta.campaignId) {
    return `/campaigns/${meta.campaignId}/dispositions`;
  }
  if (resource === 'lists' && meta.campaignId) {
    return `/campaigns/${meta.campaignId}/lists`;
  }
  return resourcePath[resource] ?? `/${resource}`;
}

function normalizeId<T extends Record<string, unknown>>(item: T): T & { id: string } {
  const id = (item.id ?? item.uuid) as string;
  return { ...item, id };
}

// Cast avoids TS generic covariance errors with react-admin's DataProvider type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const dataProvider = {
  getList: async (resource: string, params: GetListParams) => {
    const { page = 1, perPage = 25 } = params.pagination ?? {};
    const { field, order } = params.sort ?? { field: 'id', order: 'ASC' };
    const filter = (params.filter ?? {}) as Record<string, string>;
    const meta = (params.meta ?? {}) as Meta;

    const url = buildUrl(resource, meta);
    const qp = new URLSearchParams({
      page: String(page),
      pageSize: String(perPage),
      ...(field ? { sort: field, order } : {}),
      ...filter,
    });

    const { data } = await axiosClient.get<Record<string, unknown>>(
      `${url}?${qp.toString()}`
    );

    const key = listKey[resource] ?? resource;
    const items = (data[key] ?? data.data ?? []) as Record<string, unknown>[];
    const total = (data.total as number | undefined) ?? items.length;
    return { data: items.map(normalizeId), total };
  },

  getOne: async (resource: string, params: GetOneParams) => {
    const meta = (params.meta ?? {}) as Meta;
    const url = buildUrl(resource, meta);
    const { data } = await axiosClient.get<Record<string, unknown>>(
      `${url}/${params.id}`
    );
    const key = singleKey[resource] ?? resource;
    const item = (data[key] ?? data) as Record<string, unknown>;
    return { data: normalizeId(item) };
  },

  getMany: async (resource: string, params: GetManyParams) => {
    const meta = (params.meta ?? {}) as Meta;
    const url = buildUrl(resource, meta);
    const results = await Promise.all(
      params.ids.map((id) =>
        axiosClient
          .get<Record<string, unknown>>(`${url}/${id}`)
          .then((r) => {
            const key = singleKey[resource] ?? resource;
            return normalizeId((r.data[key] ?? r.data) as Record<string, unknown>);
          })
      )
    );
    return { data: results };
  },

  getManyReference: async (resource: string, params: GetManyReferenceParams) => {
    return dataProvider.getList(resource, {
      pagination: params.pagination,
      sort: params.sort,
      filter: { ...params.filter, [params.target]: params.id },
      meta: params.meta,
    });
  },

  create: async (resource: string, params: CreateParams) => {
    const meta = (params.meta ?? {}) as Meta;
    const url = buildUrl(resource, meta);
    const { data } = await axiosClient.post<Record<string, unknown>>(url, params.data);
    const created = data.id
      ? ({ ...params.data, ...data } as Record<string, unknown>)
      : data;
    return { data: normalizeId(created) };
  },

  update: async (resource: string, params: UpdateParams<RaRecord>) => {
    const meta = (params.meta ?? {}) as Meta;
    const url = buildUrl(resource, meta);
    const { data } = await axiosClient.put<Record<string, unknown>>(
      `${url}/${params.id}`,
      params.data
    );
    const updated = {
      ...(params.previousData as Record<string, unknown>),
      ...(params.data as Record<string, unknown>),
      ...data,
    };
    return { data: normalizeId(updated) };
  },

  updateMany: async (_resource: string, _params: UpdateManyParams) => {
    throw new Error('updateMany not supported');
  },

  delete: async (resource: string, params: DeleteParams<RaRecord>) => {
    const meta = (params.meta ?? {}) as Meta;
    const url = buildUrl(resource, meta);
    await axiosClient.delete(`${url}/${params.id}`);
    return { data: (params.previousData ?? { id: params.id }) as RaRecord };
  },

  deleteMany: async (resource: string, params: DeleteManyParams) => {
    const meta = (params.meta ?? {}) as Meta;
    const url = buildUrl(resource, meta);
    await Promise.all(params.ids.map((id) => axiosClient.delete(`${url}/${id}`)));
    return { data: params.ids };
  },
} as unknown as DataProvider;
