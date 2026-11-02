"""Starting board for the badge task: a 100 x 50 mm outline with two
silkscreen texts, NAME (large) and ROLE (small)."""
import sys
import pcbnew

board = pcbnew.BOARD()
mm = pcbnew.FromMM

def edge(x0, y0, x1, y1):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_RECT)
    s.SetStart(pcbnew.VECTOR2I(mm(x0), mm(y0)))
    s.SetEnd(pcbnew.VECTOR2I(mm(x1), mm(y1)))
    s.SetLayer(pcbnew.Edge_Cuts)
    s.SetWidth(mm(0.1))
    board.Add(s)

def text(value, x, y, size):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(value)
    t.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
    t.SetLayer(pcbnew.F_SilkS)
    t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
    t.SetTextThickness(mm(size / 7))
    board.Add(t)

edge(100, 100, 200, 150)
text("NAME", 150, 118, 6)
text("ROLE", 150, 136, 3)
pcbnew.SaveBoard(sys.argv[1], board)
