from pandas.api.extensions import register_dataframe_accessor


@register_dataframe_accessor("demo")
class DemoAccessor:
    """Demo dataframe accessor."""

    def summarize(self, limit: int = 5) -> str:
        """Summarize a dataframe."""
        return ""
