///<reference path='../node_modules/grafana-sdk-mocks/app/headers/common.d.ts' />
export default class VividCortexMetricsDatasource {
  apiToken: string;
  $q;

  /** @ngInject */
  constructor(instanceSettings, private backendSrv, private templateSrv, $q) {
    this.apiToken = instanceSettings.jsonData.apiToken;
    this.backendSrv = backendSrv;
    this.templateSrv = templateSrv;
    this.$q = $q;
  }

  query(options) {
    const parameters = this.getQueryParameters(options);

    if (!parameters) {
      return this.$q.when({ data: [] });
    }

    const params = {
      from: parameters.params.from,
      samplesize: 12,
      until: parameters.params.until,
      host: null,
    };

    const body = {
      metrics: parameters.metric,
    };

    const defer = this.$q.defer();

    this.doRequest('hosts', 'GET', {
      from: parameters.params.from,
      until: parameters.params.until,
    }).then(response => {
      params.host = this.filterHosts(response.data.data, options);

      this.doRequest('metrics/query-series', 'POST', params, body)
        .then(response => ({
          metrics: response.data.data || [],
          from: parseInt(response.headers('X-Vc-Meta-From')),
          until: parseInt(response.headers('X-Vc-Meta-Until')),
        }))
        .then(response => {
          defer.resolve(this.mapQueryResponse(response.metrics, response.from, response.until));
        })
        .catch(error => {
          defer.reject(error);
        });
    });

    return defer.promise;
  }

  annotationQuery(options) {
    throw new Error('Annotation support not implemented yet.');
  }

  metricFindQuery(query: string) {
    const params = {
      q: this.interpolateVariables(query),
    };

    return this.doRequest('metrics/search', 'GET', params)
      .then(response => response.data.data || [])
      .then(metrics => metrics.map(metric => ({ text: metric, value: metric })));
  }

  testDatasource() {
    const success = {
        status: 'success',
        message: 'Your VividCortex datasource was successfully configured.',
        title: 'Success',
      },
      error = {
        status: 'error',
        message:
          'The configuration test was not successful. Pleaes check your API token and Internet access and try again.',
        title: 'Credentials error',
      };

    return this.doRequest('metrics', 'GET', { limit: 1 }).then(
      response => {
        if (response.status === 200) {
          return success;
        }
        return error;
      },
      () => {
        return error;
      }
    );
  }

  /**
   * Interpolate Grafana variables and strip scape characters.
   *
   * @param  {string} metric
   * @return {string}
   */
  interpolateVariables(metric: string) {
    return this.templateSrv.replace(metric, null, 'regex').replace(/\\\./g, '.');
  }

  /**
   * Perform an HTTP request.
   *
   * @param  {string} endpoint
   * @param  {string} method
   * @param  {Object} params
   * @param  {Object} body
   * @return {Promise}
   */
  doRequest(endpoint, method, params = {}, body = {}) {
    const options = {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.apiToken,
      },
      params: params,
      url: 'https://app.vividcortex.com/api/v2/' + endpoint,
      method: method,
      data: body,
    };

    return this.backendSrv.datasourceRequest(options);
  }

  /**
   * Takes a Grafana query object and returns an object with the required information to query
   * VividCortex, or null if there is an error or no selected metrics.
   *
   * @param  {Object} options Grafana options object
   * @return {Object|null}
   */
  getQueryParameters(options) {
    const metric = options.targets.reduce((metric, target) => {
      return target.target !== 'select metric' ? target.target : metric;
    }, null);

    if (!metric) {
      return null;
    }

    return {
      metric: this.transformMetricForQuery(this.interpolateVariables(metric)),
      params: {
        from: options.range.from.unix(),
        until: options.range.to.unix(),
      },
    };
  }

  filterHosts(hosts, options) {
    const config = options.targets.reduce((hosts, target) => {
      return target.target !== 'select metric' ? target.hosts : hosts;
    }, '');

    const filters = config.split(' ');

    const filteredHosts = hosts.filter(host => {
      return filters.reduce((included, filter) => {
        if (!filter) {
          return true;
        } //include all the hosts by default

        const keyValue = filter.split('=');

        // filter === name || host[key] === value
        return included && (keyValue.length === 1 ? filter === host.name : host[keyValue[0]] === keyValue[1]);
      }, true);
    });

    return filteredHosts.map(host => host.id).join(',');
  }

  /**
   * Prepares the metric to be properly interpreted by the API. E.g. if Grafana is using template
   * variables and requesting multiple metrics.
   *
   * @param  {string} metric
   * @return {string}
   */
  transformMetricForQuery(metric: string) {
    const metrics = metric.replace(/[()]/g, '').split('|');

    if (metrics.length < 2) {
      return metric;
    }

    return metrics.join(',');
  }

  /**
   * Maps a VividCortex series response to Grafana's structure.
   *
   * @param  {Array} series
   * @param  {number} from
   * @param  {number} until
   * @return {Array}
   */
  mapQueryResponse(series: Array<any>, from: number, until: number) {
    if (!series.length || !series[0].elements.length) {
      return { data: [] };
    }

    const response = {
      data: [],
    };

    series.forEach(serie => {
      serie.elements.forEach(element => {
        const values = element.series;
        const sampleSize = (until - from) / values.length;

        response.data.push({
          target: element.metric,
          datapoints: values.map((value, index) => {
            return [value, (from + index * sampleSize) * 1e3];
          }),
        });
      });
    });

    return response;
  }
}
