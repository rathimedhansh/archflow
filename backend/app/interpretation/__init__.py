from app.interpretation.base import Interpreter
from app.interpretation.manual import ManualInterpreter


def get_interpreter() -> Interpreter:
    """The interpreter behind `GET /structure` when nothing is saved yet.

    It stays manual (an empty plan): automatic detection is an explicit user action
    (`POST /interpret`, see `app/api/interpretation.py`) whose result is a proposal the user
    reviews, so opening the editor never silently runs CV. `OpenCVInterpreter` also
    implements this interface, so a later model-backed interpreter can plug in here.
    """
    return ManualInterpreter()


__all__ = ["Interpreter", "ManualInterpreter", "get_interpreter"]
