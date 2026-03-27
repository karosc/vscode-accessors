class Convention:
    def __init__(self, dataset):
        self.dataset = dataset

    def summary(self) -> str:
        return ""

    @property
    def title(self) -> str:
        return ""
