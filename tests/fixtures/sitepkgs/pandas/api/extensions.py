def register_dataframe_accessor(name):
    def decorator(cls):
        return cls

    return decorator


def register_series_accessor(name):
    def decorator(cls):
        return cls

    return decorator


def register_index_accessor(name):
    def decorator(cls):
        return cls

    return decorator
