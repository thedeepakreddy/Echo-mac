import sys

def calculator():
    print("Simple Calculator")
    print("Available operations: +, -, *, /")
    
    try:
        num1 = float(input("Enter first number: "))
        op = input("Enter operator: ")
        num2 = float(input("Enter second number: "))
        
        if op == '+':
            result = num1 + num2
        elif op == '-':
            result = num1 - num2
        elif op == '*':
            result = num1 * num2
        elif op == '/':
            result = num1 / num2
        else:
            print("Invalid operator!")
            return
            
        print(f"Result: {result}")
    except ValueError:
        print("Invalid input!")
    except ZeroDivisionError:
        print("Cannot divide by zero!")

if __name__ == "__main__":
    calculator()
