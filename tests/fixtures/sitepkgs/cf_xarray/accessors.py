import xarray as xr


@xr.register_dataarray_accessor("cf")
class CFDataArrayAccessor:
    """Accessor for DataArray objects."""

    @property
    def axes(self) -> tuple[str, ...]:
        """Return named axes."""
        return ()

    def summary(self, include_bounds: bool = False) -> str:
        """Summarize CF metadata."""
        return ""


@xr.register_dataset_accessor("cf")
class CFDatasetAccessor:
    """Accessor for Dataset objects."""

    def summary(self, include_bounds: bool = False) -> str:
        """Summarize CF metadata."""
        return ""
