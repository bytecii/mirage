from mirage.ops.chroma.grep import grep
from mirage.ops.chroma.read import read
from mirage.ops.chroma.readdir import readdir
from mirage.ops.chroma.search import search
from mirage.ops.chroma.stat import stat

OPS = [read, readdir, stat, grep, search]
