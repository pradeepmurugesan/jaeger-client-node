// Copyright (c) 2016 Uber Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
// in compliance with the License. You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software distributed under the License
// is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
// or implied. See the License for the specific language governing permissions and limitations under
// the License.

import _ from 'lodash';
import * as url from 'url';
import { assert, expect } from 'chai';
import CompositeReporter from '../src/reporters/composite_reporter';
import RemoteReporter from '../src/reporters/remote_reporter';
import ConstSampler from '../src/samplers/const_sampler';
import ProbabilisticSampler from '../src/samplers/probabilistic_sampler';
import RemoteSampler from '../src/samplers/remote_sampler';
import RateLimitingSampler from '../src/samplers/rate_limiting_sampler';
import { initTracer, initTracerFromEnv } from '../src/index.js';
import opentracing from 'opentracing';
import RemoteThrottler from '../src/throttler/remote_throttler';
import DefaultThrottler from '../src/throttler/default_throttler';
import HTTPSender from '../src/reporters/http_sender.js';
import UDPSender from '../src/reporters/udp_sender.js';

const logger = {
  info: function info(msg) {},
};

const metrics = {
  createCounter: function createCounter() {
    return {
      increment: function() {},
    };
  },
  createGauge: function createGauge() {
    return {};
  },
  createTimer: function createTimer() {
    return {};
  },
};

describe('initTracer', () => {
  it('should initialize noop tracer when disable is set', () => {
    let config = {
      serviceName: 'test-service',
      disable: true,
    };
    let tracer = initTracer(config);

    expect(tracer).to.be.an.instanceof(opentracing.Tracer);
  });

  it('should throw error on invalid serviceName', () => {
    let configs = [{ serviceName: '' }, { serviceName: null }, {}];

    _.each(configs, config => {
      expect(() => {
        initTracer(config);
      }).to.throw('config.serviceName must be provided');
    });
  });

  it('should initialize normal tracer when only service name given', done => {
    let config = {
      serviceName: 'test-service',
    };
    let tracer = initTracer(config);

    expect(tracer._sampler).to.be.an.instanceof(RemoteSampler);
    expect(tracer._reporter).to.be.an.instanceof(RemoteReporter);
    tracer.close(done);
  });

  it('should initialize proper samplers', () => {
    let config = {
      serviceName: 'test-service',
    };
    let options = [
      { type: 'const', param: 1, expectedType: ConstSampler, expectedParam: 1 },
      { type: 'ratelimiting', param: 2, expectedType: RateLimitingSampler, expectedParam: 2 },
      { type: 'probabilistic', param: 0.5, expectedType: ProbabilisticSampler, expectedParam: 0.5 },
      { type: 'remote', param: 1, expectedType: RemoteSampler, expectedParam: 1 },
    ];

    _.each(options, samplerConfig => {
      let expectedType = samplerConfig.expectedType;
      let expectedParam = samplerConfig.expectedParam;
      delete samplerConfig.expectedType;
      delete samplerConfig.expectedParam;

      config.sampler = samplerConfig;
      let tracer = initTracer(config);

      if (tracer._sampler._delegate) {
        expect(tracer._sampler._delegate).to.be.an.instanceof(expectedType);
      } else {
        expect(tracer._sampler).to.be.an.instanceof(expectedType);
      }
      tracer.close();
      // TODO(oibe:head) test utils for expectedParam here?
    });
  });

  it('should throw error on sampler incorrect type', () => {
    let config = {
      serviceName: 'test-service',
    };
    let options = [
      { type: 'const', param: 'bad-value' },
      { type: 'ratelimiting', param: 'bad-value' },
      { type: 'probabilistic', param: 'bad-value' },
      { type: 'remote', param: 'bad-value' },
    ];

    let count = 0;
    _.each(options, samplerConfig => {
      config.sampler = samplerConfig;

      // Since its an error from a third party framework, its hard to assert on
      // using expect.
      try {
        initTracer(config);
      } catch (err) {
        count += 1;
      }
    });

    assert.equal(count, 4);
  });

  describe('reporter options', () => {
    it('should respect reporter options', done => {
      let config = {
        serviceName: 'test-service',
        sampler: {
          type: 'const',
          param: 0,
        },
        reporter: {
          logSpans: true,
          agentHost: '127.0.0.1',
          agentPort: 4939,
          flushIntervalMs: 2000,
        },
      };
      let tracer = initTracer(config);

      expect(tracer._reporter).to.be.an.instanceof(CompositeReporter);
      let remoteReporter;
      for (let i = 0; i < tracer._reporter._reporters.length; i++) {
        let reporter = tracer._reporter._reporters[i];
        if (reporter instanceof RemoteReporter) {
          remoteReporter = reporter;
          break;
        }
      }

      assert.equal(remoteReporter._bufferFlushInterval, 2000);
      assert.equal(remoteReporter._sender._host, '127.0.0.1');
      assert.equal(remoteReporter._sender._port, 4939);
      assert.instanceOf(remoteReporter._sender, UDPSender);
      tracer.close(done);
    });

    _.each(['http', 'https'], protocol => {
      it(`should create an HTTPSender if protocol is ${protocol}`, done => {
        let config = {
          serviceName: 'test-service',
          sampler: {
            type: 'const',
            param: 0,
          },
          reporter: {
            logSpans: true,
            collectorEndpoint: `${protocol}://127.0.0.1:4939/my/path`,
            username: protocol === 'https' ? 'test' : undefined,
            password: protocol === 'https' ? 'mypass' : undefined,
            flushIntervalMs: 2000,
          },
        };
        let tracer = initTracer(config);

        expect(tracer._reporter).to.be.an.instanceof(CompositeReporter);
        let remoteReporter;
        for (let i = 0; i < tracer._reporter._reporters.length; i++) {
          let reporter = tracer._reporter._reporters[i];
          if (reporter instanceof RemoteReporter) {
            remoteReporter = reporter;
            break;
          }
        }

        assert.equal(url.format(remoteReporter._sender._url), `${protocol}://127.0.0.1:4939/my/path`);
        assert.instanceOf(remoteReporter._sender, HTTPSender);
        tracer.close(done);
      });
    });
  });

  it('should pass options to tracer', done => {
    let tracer = initTracer(
      {
        serviceName: 'test-service',
      },
      {
        logger: logger,
        metrics: metrics,
        tags: {
          x: 'y',
        },
        contextKey: 'custom-header',
        baggagePrefix: 'prfx-',
      }
    );
    assert.equal(tracer._logger, logger);
    assert.equal(tracer._metrics._factory, metrics);
    assert.equal(tracer._tags['x'], 'y');

    const textMapInjector = tracer._injectors[opentracing.FORMAT_TEXT_MAP];
    assert.equal(textMapInjector._contextKey, 'custom-header');
    assert.equal(textMapInjector._baggagePrefix, 'prfx-');
    tracer.close(done);
  });

  it('should pass options to remote sampler and reporter', done => {
    let logger = {
      info: function info(msg) {},
    };
    let metrics = {
      createCounter: function createCounter() {
        return {
          increment: function() {},
        };
      },
      createGauge: function createGauge() {
        return {};
      },
      createTimer: function createTimer() {
        return {};
      },
    };
    let tracer = initTracer(
      {
        serviceName: 'test-service',
        sampler: {
          type: 'remote',
          param: 0,
        },
      },
      {
        logger: logger,
        metrics: metrics,
      }
    );
    expect(tracer._reporter).to.be.an.instanceof(RemoteReporter);
    assert.equal(tracer._reporter._metrics._factory, metrics);
    assert.equal(tracer._reporter._logger, logger);
    expect(tracer._sampler).to.be.an.instanceof(RemoteSampler);
    assert.equal(tracer._sampler._metrics._factory, metrics);
    assert.equal(tracer._sampler._logger, logger);
    tracer.close(done);
  });

  it('should initialize throttler from config', () => {
    const config = {
      serviceName: 'test-service',
      throttler: {
        refreshIntervalMs: 60000,
      },
    };
    const tracer = initTracer(config, { logger: logger, metrics: metrics });
    expect(tracer._debugThrottler).to.be.an.instanceof(RemoteThrottler);
  });

  it('should delegate throttler initialization to tracer', () => {
    const config = {
      serviceName: 'test-service',
    };
    const tracer = initTracer(config);
    expect(tracer._debugThrottler).to.be.an.instanceof(DefaultThrottler);
  });

  it('should use throttler passed in via options', () => {
    const config = {
      serviceName: 'test-service',
    };
    const throttler = new RemoteThrottler();
    const tracer = initTracer(config, { throttler: throttler });
    expect(tracer._debugThrottler).to.equal(throttler);
    throttler.close();
  });
});

describe('initTracerFromENV', () => {
  afterEach(() => {
    delete process.env.JAEGER_SERVICE_NAME;
    delete process.env.JAEGER_DISABLE;
    delete process.env.JAEGER_DISABLED;
    delete process.env.JAEGER_TAGS;
    delete process.env.JAEGER_SAMPLER_TYPE;
    delete process.env.JAEGER_SAMPLER_PARAM;
    delete process.env.JAEGER_SAMPLER_HOST;
    delete process.env.JAEGER_SAMPLER_PORT;
    delete process.env.JAEGER_SAMPLER_MANAGER_HOST_PORT;
    delete process.env.JAEGER_SAMPLER_REFRESH_INTERVAL;
    delete process.env.JAEGER_REPORTER_AGENT_PORT;
    delete process.env.JAEGER_AGENT_PORT;
    delete process.env.JAEGER_REPORTER_AGENT_HOST;
    delete process.env.JAEGER_AGENT_HOST;
    delete process.env.JAEGER_REPORTER_ENDPOINT;
    delete process.env.JAEGER_ENDPOINT;
    delete process.env.JAEGER_REPORTER_USER;
    delete process.env.JAEGER_USER;
    delete process.env.JAEGER_REPORTER_PASSWORD;
    delete process.env.JAEGER_PASSWORD;
    delete process.env.JAEGER_REPORTER_FLUSH_INTERVAL;
    delete process.env.JAEGER_REPORTER_LOG_SPANS;
  });

  it('should initialize noop tracer with mismatching disable env is set', () => {
    process.env.JAEGER_DISABLE = true;

    let tracer = initTracerFromEnv();

    expect(tracer).to.be.an.instanceof(opentracing.Tracer);
  });

  it('should initialize noop tracer with disable env is set', () => {
    process.env.JAEGER_DISABLED = true;

    let tracer = initTracerFromEnv();

    expect(tracer).to.be.an.instanceof(opentracing.Tracer);
  });

  it('should initialize tracer from mismatching env', () => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';
    process.env.JAEGER_DISABLE = false;

    let tracer = initTracerFromEnv();
    assert.equal(tracer._serviceName, 'test-service');

    tracer.close();
  });

  it('should initialize tracer from env', () => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';
    process.env.JAEGER_DISABLED = false;

    let tracer = initTracerFromEnv();
    assert.equal(tracer._serviceName, 'test-service');

    tracer.close();
  });

  it('should throw error on no serviceName', () => {
    delete process.env.JAEGER_SERVICE_NAME;
    expect(() => {
      initTracerFromEnv();
    }).to.throw('config.serviceName must be provided');
  });

  it('should parse tags', () => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';
    process.env.JAEGER_DISABLED = false;
    process.env.JAEGER_TAGS = 'KEY1=${TEST_KEY:VALUE1}, KEY2=VALUE2,KEY3=${TEST_KEY2:VALUE3}';
    process.env.TEST_KEY = 'VALUE4';
    let tracer = initTracerFromEnv();
    assert.equal(tracer._tags['KEY1'], 'VALUE4');
    assert.equal(tracer._tags['KEY2'], 'VALUE2');
    assert.equal(tracer._tags['KEY3'], 'VALUE3');

    tracer.close();
  });

  it('should initialize proper samplers from env', () => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';

    process.env.JAEGER_SAMPLER_TYPE = 'probabilistic';
    process.env.JAEGER_SAMPLER_PARAM = 0.5;
    let tracer = initTracerFromEnv();
    expect(tracer._sampler).to.be.an.instanceof(ProbabilisticSampler);
    assert.equal(tracer._sampler._samplingRate, 0.5);
    tracer.close();

    process.env.JAEGER_SAMPLER_TYPE = 'remote';
    process.env.JAEGER_SAMPLER_MANAGER_HOST_PORT = 'localhost:8080';
    process.env.JAEGER_SAMPLER_REFRESH_INTERVAL = 100;
    tracer = initTracerFromEnv();
    expect(tracer._sampler).to.be.an.instanceof(RemoteSampler);
    assert.equal(tracer._sampler._host, 'localhost');
    assert.equal(tracer._sampler._port, 8080);
    assert.equal(tracer._sampler._refreshInterval, 100);
    tracer.close();
  });

  it('should initialize proper samplers from mismatching env', () => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';

    process.env.JAEGER_SAMPLER_TYPE = 'probabilistic';
    process.env.JAEGER_SAMPLER_PARAM = 0.5;
    let tracer = initTracerFromEnv();
    expect(tracer._sampler).to.be.an.instanceof(ProbabilisticSampler);
    assert.equal(tracer._sampler._samplingRate, 0.5);
    tracer.close();

    process.env.JAEGER_SAMPLER_TYPE = 'remote';
    process.env.JAEGER_SAMPLER_HOST = 'localhost';
    process.env.JAEGER_SAMPLER_PORT = 8080;
    process.env.JAEGER_SAMPLER_REFRESH_INTERVAL = 100;
    tracer = initTracerFromEnv();
    expect(tracer._sampler).to.be.an.instanceof(RemoteSampler);
    assert.equal(tracer._sampler._host, 'localhost');
    assert.equal(tracer._sampler._port, 8080);
    assert.equal(tracer._sampler._refreshInterval, 100);
    tracer.close();
  });

  it('should respect udp reporter options from env', done => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';
    process.env.JAEGER_REPORTER_LOG_SPANS = 'true';
    process.env.JAEGER_AGENT_HOST = '127.0.0.1';
    process.env.JAEGER_AGENT_PORT = 4939;
    process.env.JAEGER_REPORTER_FLUSH_INTERVAL = 2000;

    let tracer = initTracerFromEnv();
    expect(tracer._reporter).to.be.an.instanceof(CompositeReporter);
    let remoteReporter;
    for (let i = 0; i < tracer._reporter._reporters.length; i++) {
      let reporter = tracer._reporter._reporters[i];
      if (reporter instanceof RemoteReporter) {
        remoteReporter = reporter;
        break;
      }
    }

    assert.equal(remoteReporter._bufferFlushInterval, 2000);
    assert.equal(remoteReporter._sender._host, '127.0.0.1');
    assert.equal(remoteReporter._sender._port, 4939);
    assert.instanceOf(remoteReporter._sender, UDPSender);

    tracer.close(done);
  });

  it('should respect udp reporter options from mismatching env', done => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';
    process.env.JAEGER_REPORTER_LOG_SPANS = 'true';
    process.env.JAEGER_REPORTER_AGENT_HOST = '127.0.0.1';
    process.env.JAEGER_REPORTER_AGENT_PORT = 4939;
    process.env.JAEGER_REPORTER_FLUSH_INTERVAL = 2000;

    let tracer = initTracerFromEnv();
    expect(tracer._reporter).to.be.an.instanceof(CompositeReporter);
    let remoteReporter;
    for (let i = 0; i < tracer._reporter._reporters.length; i++) {
      let reporter = tracer._reporter._reporters[i];
      if (reporter instanceof RemoteReporter) {
        remoteReporter = reporter;
        break;
      }
    }

    assert.equal(remoteReporter._bufferFlushInterval, 2000);
    assert.equal(remoteReporter._sender._host, '127.0.0.1');
    assert.equal(remoteReporter._sender._port, 4939);
    assert.instanceOf(remoteReporter._sender, UDPSender);

    tracer.close(done);
  });

  it('should respect http reporter options from env', done => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';
    process.env.JAEGER_REPORTER_FLUSH_INTERVAL = 3000;
    process.env.JAEGER_ENDPOINT = 'http://127.0.0.1:8080';
    process.env.JAEGER_USER = 'test';
    process.env.JAEGER_PASSWORD = 'xxxx';

    let tracer = initTracerFromEnv();
    expect(tracer._reporter).to.be.an.instanceof(RemoteReporter);
    assert.instanceOf(tracer._reporter._sender, HTTPSender);
    assert.equal(tracer._reporter._bufferFlushInterval, 3000);
    assert.equal(tracer._reporter._sender._url.href, 'http://127.0.0.1:8080/');
    assert.equal(tracer._reporter._sender._username, 'test');
    assert.equal(tracer._reporter._sender._password, 'xxxx');

    tracer.close(done);
  });

  it('should respect http reporter options from mismatching env', done => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';
    process.env.JAEGER_REPORTER_FLUSH_INTERVAL = 3000;
    process.env.JAEGER_REPORTER_ENDPOINT = 'http://127.0.0.1:8080';
    process.env.JAEGER_REPORTER_USER = 'test';
    process.env.JAEGER_REPORTER_PASSWORD = 'xxxx';

    let tracer = initTracerFromEnv();
    expect(tracer._reporter).to.be.an.instanceof(RemoteReporter);
    assert.instanceOf(tracer._reporter._sender, HTTPSender);
    assert.equal(tracer._reporter._bufferFlushInterval, 3000);
    assert.equal(tracer._reporter._sender._url.href, 'http://127.0.0.1:8080/');
    assert.equal(tracer._reporter._sender._username, 'test');
    assert.equal(tracer._reporter._sender._password, 'xxxx');

    tracer.close(done);
  });

  it('should be overridden via direct config setting.', done => {
    process.env.JAEGER_SERVICE_NAME = 'test-service';
    process.env.JAEGER_DISABLED = false;
    process.env.JAEGER_SAMPLER_TYPE = 'const';
    process.env.JAEGER_SAMPLER_PARAM = 1;
    process.env.JAEGER_TAGS = 'KEY1=VALUE1';

    let config = {
      serviceName: 'test-service-arg',
      sampler: {
        type: 'remote',
        host: 'localhost',
        port: 8080,
        refreshIntervalMs: 100,
      },
    };
    let options = {
      tags: {
        KEY2: 'VALUE2',
      },
    };
    let tracer = initTracerFromEnv(config, options);
    assert.equal(tracer._serviceName, 'test-service-arg');
    expect(tracer._sampler).to.be.an.instanceof(RemoteSampler);
    assert.equal(tracer._sampler._host, 'localhost');
    assert.equal(tracer._sampler._port, 8080);
    assert.equal(tracer._sampler._refreshInterval, 100);
    assert.equal(tracer._tags['KEY2'], 'VALUE2');
    tracer.close(done);
  });
});
