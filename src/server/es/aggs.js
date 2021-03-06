import { getFilterObj } from './filter';
import {
  AGGS_GLOBAL_STATS_NAME,
  AGGS_ITEM_STATS_NAME,
  AGGS_QUERY_NAME,
} from './const';

const appendAdditionalRangeQuery = (field, oldQuery, rangeStart, rangeEnd) => {
  const appendFilter = [];
  if (typeof rangeStart !== 'undefined') {
    appendFilter.push({
      range: {
        [field]: { gte: rangeStart },
      },
    });
  }
  if (typeof rangeEnd !== 'undefined') {
    appendFilter.push({
      range: {
        [field]: { lt: rangeEnd },
      },
    });
  }
  if (appendFilter.length > 0) {
    const newQuery = {
      bool: {
        must: oldQuery ? [
          oldQuery,
          [...appendFilter],
        ] : [...appendFilter],
      },
    };
    return newQuery;
  }
  return oldQuery;
};

/**
 * get global stats for a field
 * @param {*} param0
 * @returns {min, max, sum, count, avg, key}
 */
const numericGlobalStats = async (
  {
    esInstance,
    esIndex,
    esType,
  },
  {
    filter,
    field,
    rangeStart,
    rangeEnd,
  }) => {
  const queryBody = { size: 0 };
  if (typeof filter !== 'undefined') {
    queryBody.query = getFilterObj(esInstance, esIndex, esType, filter);
  }
  queryBody.query = appendAdditionalRangeQuery(field, queryBody.query, rangeStart, rangeEnd);
  const aggsObj = {
    [AGGS_GLOBAL_STATS_NAME]: {
      stats: { field },
    },
  };
  queryBody.aggs = aggsObj;
  const result = await esInstance.query(esIndex, esType, queryBody);
  let resultStats = result.aggregations[AGGS_GLOBAL_STATS_NAME];
  const range = [
    typeof rangeStart === 'undefined' ? resultStats.min : rangeStart,
    typeof rangeEnd === 'undefined' ? resultStats.max : rangeEnd,
  ];
  resultStats = {
    key: range,
    ...resultStats,
  };
  return resultStats;
};

const numericHistogramWithFixedRangeStep = async (
  {
    esInstance,
    esIndex,
    esType,
  },
  {
    filter,
    field,
    rangeStart,
    rangeEnd,
    rangeStep,
    filterSelf,
  }) => {
  const queryBody = { size: 0 };
  if (typeof filter !== 'undefined') {
    queryBody.query = getFilterObj(esInstance, esIndex, esType, filter, field, filterSelf);
  }
  queryBody.query = appendAdditionalRangeQuery(field, queryBody.query, rangeStart, rangeEnd);
  const aggsObj = {
    [AGGS_GLOBAL_STATS_NAME]: {
      stats: { field },
    },
  };
  aggsObj[AGGS_QUERY_NAME] = {
    histogram: {
      field,
      interval: rangeStep,
    },
    aggs: {
      [AGGS_ITEM_STATS_NAME]: {
        stats: {
          field,
        },
      },
    },
  };
  if (typeof rangeStart !== 'undefined') {
    let offset = rangeStart;
    while (offset - rangeStep > 0) {
      offset -= rangeStep;
    }
    aggsObj[AGGS_QUERY_NAME].histogram.offset = offset;
  }
  queryBody.aggs = aggsObj;
  const result = await esInstance.query(esIndex, esType, queryBody);
  const parsedAggsResult = result.aggregations[AGGS_QUERY_NAME].buckets.map(item => ({
    key: [item.key, item.key + rangeStep],
    ...item[AGGS_ITEM_STATS_NAME],
  }));
  return parsedAggsResult;
};

const numericHistogramWithFixedBinCount = async (
  {
    esInstance,
    esIndex,
    esType,
  },
  {
    filter,
    field,
    rangeStart,
    rangeEnd,
    binCount,
    filterSelf,
  }) => {
  const globalStats = await numericGlobalStats(
    {
      esInstance,
      esIndex,
      esType,
    },
    {
      filter,
      field,
      rangeStart,
      rangeEnd,
    },
  );
  const { min, max } = globalStats;
  const histogramStart = typeof rangeStart === 'undefined' ? min : rangeStart;
  const histogramEnd = typeof rangeEnd === 'undefined' ? (max + 1) : rangeEnd;
  const rangeStep = (histogramEnd - histogramStart) / binCount;
  return numericHistogramWithFixedRangeStep(
    {
      esInstance,
      esIndex,
      esType,
    },
    {
      filter,
      field,
      rangeStart: histogramStart,
      rangeEnd: histogramEnd,
      rangeStep,
      filterSelf,
    },
  );
};

export const numericAggregation = async (
  {
    esInstance,
    esIndex,
    esType,
  },
  {
    filter,
    field,
    rangeStart,
    rangeEnd,
    rangeStep,
    binCount,
    filterSelf,
  },
) => {
  if (rangeStep <= 0) {
    throw new Error(`Invalid rangeStep ${rangeStep}`);
  }
  if (rangeStart > rangeEnd) {
    throw new Error(`Invalid rangeStart (${rangeStep}) > rangeEnd (${rangeEnd})`);
  }
  if (binCount <= 0) {
    throw new Error(`Invalid binCount ${binCount}`);
  }
  if (typeof rangeStep !== 'undefined' && typeof binCount !== 'undefined') {
    throw new Error('Cannot set "rangeStep" and "binCount" at same time.');
  }
  if (typeof rangeStep !== 'undefined') {
    return numericHistogramWithFixedRangeStep(
      {
        esInstance,
        esIndex,
        esType,
      },
      {
        esIndex,
        esType,
        filter,
        field,
        rangeStart,
        rangeEnd,
        rangeStep,
        filterSelf,
      },
    );
  }
  if (typeof binCount !== 'undefined') {
    return numericHistogramWithFixedBinCount(
      {
        esInstance,
        esIndex,
        esType,
      },
      {
        filter,
        field,
        rangeStart,
        rangeEnd,
        binCount,
        filterSelf,
      },
    );
  }
  const result = await numericGlobalStats(
    {
      esInstance,
      esIndex,
      esType,
    },
    {
      filter,
      field,
      rangeStart,
      rangeEnd,
    },
  );
  return [result];
};

const PAGE_SIZE = 1024;
export const textAggregation = async (
  {
    esInstance,
    esIndex,
    esType,
  },
  {
    filter,
    field,
    filterSelf,
  },
) => {
  const queryBody = { size: 0 };
  if (typeof filter !== 'undefined') {
    queryBody.query = getFilterObj(esInstance, esIndex, esType, filter, field, filterSelf);
  }
  const aggsName = `${field}Aggs`;
  queryBody.aggs = {
    [aggsName]: {
      composite: {
        sources: [
          {
            [field]: {
              terms: {
                field,
              },
            },
          },
        ],
        size: PAGE_SIZE,
      },
    },
  };
  let resultSize;
  const finalResults = [];
  /* eslint-disable */
  do {
    const result = await esInstance.query(esIndex, esType, queryBody); 
    resultSize = 0;

    result.aggregations[aggsName].buckets.forEach((item) => {
      finalResults.push({
        key: item.key[field],
        count: item.doc_count,
      });
      resultSize += 1;
    });
    queryBody.aggs[aggsName].composite.after = result.aggregations[aggsName].after_key;
  } while (resultSize === PAGE_SIZE);
  /* eslint-enable */
  return finalResults;
};
