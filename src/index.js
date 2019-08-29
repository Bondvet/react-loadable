'use strict';
const ReactLocalizeRedux = require('react-localize-redux');
const React = require('react');
const PropTypes = require('prop-types');
const { ReactReduxContext } = require('react-redux');

const ALL_INITIALIZERS = [];
const READY_INITIALIZERS = [];

const LoadableContext = React.createContext({
    report: () => {},
});

function isWebpackReady(getModuleIds) {
    if (typeof __webpack_modules__ !== 'object') {
        return false;
    }

    return getModuleIds().every(moduleId => {
        return (
            typeof moduleId !== 'undefined' &&
            typeof __webpack_modules__[moduleId] !== 'undefined'
        );
    });
}

function load(loader) {
    const promise = loader();

    const state = {
        loading: true,
        loaded: null,
        error: null,
    };

    state.promise = promise
        .then(loaded => {
            state.loading = false;
            state.loaded = loaded;
            return loaded;
        })
        .catch(err => {
            state.loading = false;
            state.error = err;
            throw err;
        });

    return state;
}

function loadMap(obj) {
    const state = {
        loading: false,
        loaded: {},
        error: null,
    };

    const promises = [];

    try {
        Object.keys(obj).forEach(key => {
            const result = load(obj[key]);

            if (!result.loading) {
                state.loaded[key] = result.loaded;
                state.error = result.error;
            } else {
                state.loading = true;
            }

            promises.push(result.promise);

            result.promise
                .then(res => {
                    state.loaded[key] = res;
                })
                .catch(err => {
                    state.error = err;
                });
        });
    } catch (err) {
        state.error = err;
    }

    state.promise = Promise.all(promises)
        .then(res => {
            state.loading = false;
            return res;
        })
        .catch(err => {
            state.loading = false;
            throw err;
        });

    return state;
}

const defaultLoading = () => <div>Loading ...</div>;

const emptyLoader = () => Promise.resolve(null);

function getRedux({ reducers, sagas, initialState, selectors }) {
    if (reducers || sagas || initialState || selectors) {
        return { reducers, sagas, initialState, selectors };
    }

    return null;
}

function createLoadableComponent(loadFn, options) {
    if (!options.loading) {
        options.loading = defaultLoading;
    }

    function resolve(obj) {
        if (obj) {
            if (options.componentName) {
                return obj[options.componentName];
            }

            return obj && obj.__esModule ? obj.default : obj;
        }
    }

    function render(loaded, props) {
        return React.createElement(resolve(loaded.component), props);
    }

    const localizeVersion = !!LocalizeContext.LocalizeContext ? 3 : 2;
    const opts = Object.assign(
        {
            loader: null,
            loading: null,
            delay: 200,
            timeout: null,
            render: render,
            webpack: null,
            modules: null,
            redux: emptyLoader,
            translations: emptyLoader,
        },
        options
    );

    let res = null;
    let theStore = null;
    let localizeContext = null;
    function initRedux(
        store,
        { translations: _translations, redux: _redux, component }
    ) {
        const { reducerName, translationsScope } = options;
        const redux = _redux || getRedux(component);
        const translations = _translations || component.translations;

        // inject async reducers, if given
        if (redux) {
            const { reducers, sagas, selectors, initialState } = redux;

            if (reducerName) {
                if (reducers && store.injectAsyncReducer) {
                    store.injectAsyncReducer(reducerName, reducers);
                }

                if (selectors && store.injectSelectors) {
                    store.injectSelectors(reducerName, selectors, initialState);
                }
            }

            // inject sagas
            if (sagas && store.setSagas) {
                store.setSagas(sagas);
            }
        }

        // add translations
        if (translations) {
            if (localizeVersion === 2) {
                if (store.addTranslations) {
                    store.addTranslations(
                        translations,
                        translationsScope || reducerName
                    );
                }
            } else if (localizeContext) {
                const key = translationsScope || reducerName;
                Object.keys(translations).forEach(language => {
                    localizeContext.addTranslationForLanguage(
                        {
                            [key]: translations[language],
                        },
                        language
                    );
                });
            }
        }
    }

    function init() {
        if (!res) {
            res = loadFn({
                component: opts.loader,
                redux: opts.redux,
                translations: opts.translations,
            });
        }
        return res.promise.then(data => {
            if (theStore) {
                initRedux(theStore, res.loaded);
            }

            return data;
        });
    }

    ALL_INITIALIZERS.push(init);

    if (typeof opts.webpack === 'function') {
        READY_INITIALIZERS.push(() => {
            if (isWebpackReady(opts.webpack)) {
                return init();
            }
        });
    }

    class LoadableComponent extends React.Component {
        constructor(props, context) {
            super(props, context);
            init();

            this.state = {
                error: res.error,
                pastDelay: false,
                timedOut: false,
                loading: res.loading,
                loaded: res.loaded,
            };

            this._loadModule();
        }

        static contextType = LoadableContext;

        _mounted = true;

        _loadModule() {
            if (this.context.report && Array.isArray(opts.modules)) {
                opts.modules.forEach(moduleName => {
                    this.context.report(moduleName);
                });
            }

            if (!res.loading) {
                return;
            }

            if (typeof opts.delay === 'number') {
                if (opts.delay === 0) {
                    this.setState({ pastDelay: true });
                } else {
                    this._delay = setTimeout(() => {
                        this.setState({ pastDelay: true });
                    }, opts.delay);
                }
            }

            if (typeof opts.timeout === 'number') {
                this._timeout = setTimeout(() => {
                    this.setState({ timedOut: true });
                }, opts.timeout);
            }

            const update = () => {
                if (!this._mounted) {
                    return;
                }

                this.setState({
                    error: res.error,
                    loaded: res.loaded,
                    loading: res.loading,
                });

                this._clearTimeouts();
            };

            res.promise
                .then(() => {
                    initRedux(this.props.store, res.loaded);
                    update();
                })
                .catch(error => {
                    console.warn('error loading', options.componentName, error);
                    update();
                });
        }

        componentWillUnmount() {
            this._mounted = false;
            this._clearTimeouts();
        }

        _clearTimeouts() {
            clearTimeout(this._delay);
            clearTimeout(this._timeout);
        }

        retry = () => {
            this.setState({ error: null, loading: true, timedOut: false });
            res = loadFn(opts.loader);
            this._loadModule();
        };

        render() {
            if (this.state.loading || this.state.error) {
                return React.createElement(opts.loading, {
                    isLoading: this.state.loading,
                    pastDelay: this.state.pastDelay,
                    timedOut: this.state.timedOut,
                    error: this.state.error,
                    retry: this.retry,
                });
            } else if (this.state.loaded) {
                const { store, ...props } = this.props;
                return opts.render(this.state.loaded, props);
            } else {
                return null;
            }
        }
    }

    function renderWithStore(store, props) {
        if (theStore !== store) {
            theStore = store;
        }

        return <LoadableComponent store={store} {...props} />;
    }

    if (localizeVersion === 2) {
        return class LoadableWrapper extends React.Component {
            static preload() {
                return init();
            }

            render() {
                return (
                    <ReactReduxContext.Consumer>
                        {({ store }) => renderWithStore(store, this.props)}
                    </ReactReduxContext.Consumer>
                );
            }
        };
    }

    return class LocalizedLoadableWraper extends React.Component {
        static preload() {
            return init();
        }
        render() {
            return (
                <LocalizeContext.Consumer>
                    {context => {
                        if (localizeContext !== context) {
                            localizeContext = context;
                        }
                        return (
                            <ReactReduxContext.Consumer>
                                {({ store }) =>
                                    renderWithStore(store, this.props)
                                }
                            </ReactReduxContext.Consumer>
                        );
                    }}
                </LocalizeContext.Consumer>
            );
        }
    };
}

function Loadable(opts) {
    return createLoadableComponent(loadMap, opts);
}

function LoadableMap(opts) {
    if (typeof opts.render !== 'function') {
        throw new Error(
            'LoadableMap requires a `render(loaded, props)` function'
        );
    }

    return createLoadableComponent(loadMap, opts);
}

Loadable.Map = LoadableMap;

class Capture extends React.Component {
    static propTypes = {
        report: PropTypes.func.isRequired,
    };

    state = {
        report: this.props.report,
    };

    render() {
        return (
            <LoadableContext.Provider value={this.state}>
                {React.Children.only(this.props.children)}
            </LoadableContext.Provider>
        );
    }
}

Loadable.Capture = Capture;

function flushInitializers(initializers) {
    const promises = [];

    while (initializers.length) {
        const init = initializers.pop();
        promises.push(init());
    }

    return Promise.all(promises).then(() => {
        if (initializers.length) {
            return flushInitializers(initializers);
        }
    });
}

Loadable.preloadAll = () => {
    return new Promise((resolve, reject) => {
        flushInitializers(ALL_INITIALIZERS).then(resolve, reject);
    });
};

Loadable.preloadReady = () => {
    return new Promise((resolve, reject) => {
        // We always will resolve, errors should be handled within loading UIs.
        flushInitializers(READY_INITIALIZERS).then(resolve, resolve);
    });
};

module.exports = Loadable;
